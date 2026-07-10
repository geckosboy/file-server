import assert from 'node:assert/strict';
import { Kafka, logLevel } from 'kafkajs';
import pg from 'pg';

import {
	createInfrastructureConfig,
	ensureKafkaTopic,
	fetchJson,
	getFreePort,
	migrateDatabase,
	poll,
	printChildLogs,
	run,
	spawnService,
	startInfrastructureService,
	startInfrastructure,
	stopChild,
	stopInfrastructureService,
	stopInfrastructure,
	waitForHttp,
} from './system-test-utils.mjs';

const { Client: PostgreSqlClient } = pg;

const resolvePort = async (environmentName) =>
	Number(process.env[environmentName] || (await getFreePort()));
const appPorts = {
	telemetry: await resolvePort('SYSTEM_E2E_TELEMETRY_PORT'),
	cache: await resolvePort('SYSTEM_E2E_CACHE_PORT'),
	cacheReplica: await resolvePort('SYSTEM_E2E_CACHE_REPLICA_PORT'),
	resize: await resolvePort('SYSTEM_E2E_RESIZE_PORT'),
	storage: await resolvePort('SYSTEM_E2E_STORAGE_PORT'),
};
const appBaseUrls = {
	telemetry: `http://127.0.0.1:${appPorts.telemetry}`,
	storage: `http://127.0.0.1:${appPorts.storage}`,
	resize: `http://127.0.0.1:${appPorts.resize}`,
	cache: `http://127.0.0.1:${appPorts.cache}`,
	cacheReplica: `http://127.0.0.1:${appPorts.cacheReplica}`,
};
const adminToken = 'system-e2e-admin-token';
const internalApiKey = 'system-e2e-internal-key';
const clientApiKeyPepper = 'system-e2e-client-pepper';
const origin = 'http://127.0.0.1:43199';
const children = [];
const infrastructure = await createInfrastructureConfig('system-e2e');
const telemetryKafkaGroupId = `system-e2e-telemetry-${process.pid}`;
const telemetryTopic = 'file.image.events.v1';
const telemetryDlqTopic = `${telemetryTopic}.dlq`;
const lifecycleTopic = 'file.image.lifecycle.v1';
let telemetryChild;
let storageChild;
let resizeChild;

const commonAppEnv = {
	NODE_ENV: 'production',
	HOST: '127.0.0.1',
	ORIGIN_LIST_STR: origin,
	DATABASE_URL: infrastructure.databaseUrl,
	KAFKA_CLIENT_BROKERS: infrastructure.kafkaBroker,
	CLIENT_API_KEY_PEPPER: clientApiKeyPepper,
	INTERNAL_API_KEY: internalApiKey,
};

const adminHeaders = {
	'content-type': 'application/json',
	'x-admin-token': adminToken,
	'x-admin-actor': 'system-e2e',
	'x-request-id': `system-e2e-admin-${process.pid}`,
};

const startResizeApplication = async () => {
	const resize = spawnService({
		name: 'resize',
		entry: 'apps/resize/dist/apps/resize/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(appPorts.resize),
			STORAGE_SERVER: appBaseUrls.storage,
		},
	});
	resizeChild = resize;
	children.push(resize);
	await waitForHttp(`${appBaseUrls.resize}/health/live`, {
		child: resize,
		timeoutMs: 45_000,
	});
	return resize;
};

const startApplications = async () => {
	const telemetry = spawnService({
		name: 'telemetry-api',
		entry: 'apps/telemetry-api/dist/apps/telemetry-api/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(appPorts.telemetry),
			TELEMETRY_ADMIN_TOKEN: adminToken,
			TELEMETRY_STORAGE_DRIVER: 'prisma',
			CLIENT_SERVICE_REGISTRY_DRIVER: 'prisma',
			TELEMETRY_KAFKA_CONSUMER_ENABLED: 'true',
			TELEMETRY_KAFKA_FROM_BEGINNING: 'true',
			TELEMETRY_KAFKA_GROUP_ID: telemetryKafkaGroupId,
			TELEMETRY_KAFKA_RETRY_MAX_ATTEMPTS: '2',
			TELEMETRY_KAFKA_RETRY_BACKOFF_MS: '100',
			LIFECYCLE_KAFKA_CONSUMER_ENABLED: 'true',
			LIFECYCLE_KAFKA_FROM_BEGINNING: 'true',
			LIFECYCLE_KAFKA_GROUP_ID: `system-e2e-lifecycle-${process.pid}`,
			LIFECYCLE_TOPIC_PROVISIONING_ENABLED: 'false',
		},
	});
	telemetryChild = telemetry;
	children.push(telemetry);
	await waitForHttp(`${appBaseUrls.telemetry}/health/ready`, {
		child: telemetry,
		timeoutMs: 45_000,
	});

	const storage = spawnService({
		name: 'storage',
		entry: 'apps/storage/dist/apps/storage/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(appPorts.storage),
			CACHE_SERVER: appBaseUrls.cache,
			LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS: '250',
		},
	});
	storageChild = storage;
	children.push(storage);
	await waitForHttp(`${appBaseUrls.storage}/health/ready`, {
		child: storage,
		timeoutMs: 45_000,
	});

	const resize = await startResizeApplication();
	await waitForHttp(`${appBaseUrls.resize}/health/ready`, {
		child: resize,
		timeoutMs: 45_000,
	});

	const cache = spawnService({
		name: 'cache',
		entry: 'apps/cache/dist/apps/cache/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(appPorts.cache),
			RESIZING_SERVER: appBaseUrls.resize,
		},
	});
	children.push(cache);
	await waitForHttp(`${appBaseUrls.cache}/health/ready`, {
		child: cache,
		timeoutMs: 45_000,
	});

	const cacheReplica = spawnService({
		name: 'cache-replica',
		entry: 'apps/cache/dist/apps/cache/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(appPorts.cacheReplica),
			RESIZING_SERVER: appBaseUrls.resize,
		},
	});
	children.push(cacheReplica);
	await waitForHttp(`${appBaseUrls.cacheReplica}/health/ready`, {
		child: cacheReplica,
		timeoutMs: 45_000,
	});
};

const runScenario = async () => {
	const telemetryBaseUrl = appBaseUrls.telemetry;
	const storageBaseUrl = appBaseUrls.storage;
	const cacheBaseUrl = appBaseUrls.cache;
	const cacheReplicaBaseUrl = appBaseUrls.cacheReplica;

	const service = await fetchJson(
		`${telemetryBaseUrl}/api/admin/client-services`,
		{
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({
				slug: `system-e2e-${process.pid}`,
				name: 'System E2E',
				owner: 'ci',
			}),
		},
		201,
	);
	assert.equal(typeof service.id, 'string');
	const lifecycleSubscription = await fetchJson(
		`${telemetryBaseUrl}/api/admin/client-services/${service.id}/lifecycle-subscriptions`,
		{
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({
				eventType: 'image.upload.completed',
				consumerGroup: `system-e2e-client-lifecycle-${process.pid}`,
			}),
		},
		201,
	);
	assert.equal(
		lifecycleSubscription.topic,
		`file.image.lifecycle.client.${service.id.toLowerCase()}.v1`,
	);
	assert.equal(lifecycleSubscription.provisioningStatus, 'PENDING');
	await ensureKafkaTopic(infrastructure, lifecycleSubscription.topic);
	await fetchJson(
		`${telemetryBaseUrl}/api/admin/client-services/${service.id}/policies`,
		{
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({
				pathPattern: 'system-e2e/image',
				canRead: true,
				canUpload: true,
				canDelete: true,
				maxUploadBytes: 1_048_576,
				rateLimitPerMin: 3,
			}),
		},
		201,
	);

	const keyResult = await fetchJson(
		`${telemetryBaseUrl}/api/admin/client-services/${service.id}/keys`,
		{
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({ name: 'system-e2e' }),
		},
		201,
	);
	assert.equal(typeof keyResult.apiKey, 'string');
	const clientHeaders = { 'x-client-api-key': keyResult.apiKey };

	const otherService = await fetchJson(
		`${telemetryBaseUrl}/api/admin/client-services`,
		{
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({
				slug: `system-e2e-other-${process.pid}`,
				name: 'System E2E Other',
				owner: 'ci',
			}),
		},
		201,
	);
	await fetchJson(
		`${telemetryBaseUrl}/api/admin/client-services/${otherService.id}/policies`,
		{
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({
				pathPattern: 'system-e2e-other/image',
				canRead: true,
				canUpload: true,
				canDelete: true,
			}),
		},
		201,
	);
	const otherKeyResult = await fetchJson(
		`${telemetryBaseUrl}/api/admin/client-services/${otherService.id}/keys`,
		{
			method: 'POST',
			headers: adminHeaders,
			body: JSON.stringify({ name: 'system-e2e-other' }),
		},
		201,
	);
	const otherClientHeaders = {
		'x-client-api-key': otherKeyResult.apiKey,
	};

	const imageBuffer = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP8z8AARAwMjDAGAAANHQEDasKb6QAAAABJRU5ErkJggg==',
		'base64',
	);
	const form = new FormData();
	form.set('path', 'system-e2e/image');
	form.set(
		'file',
		new Blob([imageBuffer], { type: 'image/png' }),
		'sample.png',
	);
	const uploadResponse = await fetch(`${storageBaseUrl}/image`, {
		method: 'POST',
		headers: clientHeaders,
		body: form,
	});
	const uploadBody = await uploadResponse.json();
	assert.equal(uploadResponse.status, 201, JSON.stringify(uploadBody));
	assert.equal(uploadBody.path, 'system-e2e/image');
	assert.equal(typeof uploadBody.name, 'string');
	assert.equal(typeof uploadBody.eventId, 'string');

	const imageUrl = new URL(
		`/image/system-e2e/${encodeURIComponent(uploadBody.name)}`,
		cacheBaseUrl,
	);
	imageUrl.searchParams.set('width', '4');
	imageUrl.searchParams.set('height', '4');
	imageUrl.searchParams.set('format', 'webp');
	const firstRead = await fetch(imageUrl, { headers: clientHeaders });
	const firstBytes = Buffer.from(await firstRead.arrayBuffer());
	assert.equal(firstRead.status, 200);
	assert.match(firstRead.headers.get('content-type') ?? '', /^image\/webp/);
	assert.ok(firstBytes.byteLength > 0);

	const crossTenantRead = await fetch(imageUrl, {
		headers: otherClientHeaders,
	});
	assert.equal(crossTenantRead.status, 403);

	const unauthorizedUploadForm = new FormData();
	unauthorizedUploadForm.set('path', 'system-e2e/image');
	unauthorizedUploadForm.set(
		'file',
		new Blob([imageBuffer], { type: 'image/png' }),
		'cross-tenant.png',
	);
	const crossTenantUpload = await fetch(`${storageBaseUrl}/image`, {
		method: 'POST',
		headers: otherClientHeaders,
		body: unauthorizedUploadForm,
	});
	assert.equal(crossTenantUpload.status, 403);

	const crossTenantDelete = await fetch(
		`${storageBaseUrl}/image?imageKey=${encodeURIComponent(uploadBody.imageKey)}`,
		{ method: 'DELETE', headers: otherClientHeaders },
	);
	assert.equal(crossTenantDelete.status, 403);

	const secondRead = await fetch(imageUrl, { headers: clientHeaders });
	const secondBytes = Buffer.from(await secondRead.arrayBuffer());
	assert.equal(secondRead.status, 200);
	assert.deepEqual(secondBytes, firstBytes);

	const replicaImageUrl = new URL(imageUrl.pathname, cacheReplicaBaseUrl);
	replicaImageUrl.search = imageUrl.search;
	const replicaAllowedRead = await fetch(replicaImageUrl, {
		headers: clientHeaders,
	});
	assert.equal(replicaAllowedRead.status, 200);
	const replicaRateLimitedRead = await fetch(replicaImageUrl, {
		headers: clientHeaders,
	});
	assert.equal(replicaRateLimitedRead.status, 429);

	await poll(async () => {
		const result = await fetchJson(
			`${telemetryBaseUrl}/api/admin/events?limit=100`,
			{ headers: adminHeaders },
		);
		assert.ok(
			result.items.some((event) => event.eventId === uploadBody.eventId),
			'upload telemetry event가 PostgreSQL에 저장되지 않았습니다.',
		);
		assert.ok(
			result.items.some(
				(event) =>
					event.clientServiceId === service.id &&
					event.eventType === 'image.cache.hit',
			),
			'cache hit telemetry event가 PostgreSQL에 저장되지 않았습니다.',
		);
	});

	const clientLifecycleEvent = await consumeKafkaEvent({
		broker: infrastructure.kafkaBroker,
		topic: lifecycleSubscription.topic,
		eventId: uploadBody.eventId,
	});
	assert.equal(clientLifecycleEvent.eventId, uploadBody.eventId);

	await poll(async () => {
		const result = await fetchJson(
			`${telemetryBaseUrl}/api/admin/lifecycle-events?limit=100`,
			{ headers: adminHeaders },
		);
		assert.ok(
			result.items.some((event) => event.eventId === uploadBody.eventId),
			'upload lifecycle event가 PostgreSQL에 저장되지 않았습니다.',
		);
	});

	await fetchJson(
		`${storageBaseUrl}/image?imageKey=${encodeURIComponent(uploadBody.imageKey)}`,
		{ method: 'DELETE', headers: clientHeaders },
		200,
	);

	await proveRequiredUpstreamHealth({
		cacheBaseUrl,
		cacheReplicaBaseUrl,
	});
	await proveKafkaOutageHealth();
	await provePoisonDlqProgress({ telemetryBaseUrl });
	await proveDatabaseOutageRedelivery({ telemetryBaseUrl });

	console.log(
		`System E2E 통과: upload=${uploadBody.imageKey}, cross-tenant 403, shared replica rate-limit 429, cache/resize/storage chain, telemetry, lifecycle`,
	);
};

const readHealthResponse = async (url, headers) => {
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(5_000),
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = text;
	}
	const health =
		body?.message &&
		typeof body.message === 'object' &&
		!Array.isArray(body.message)
			? body.message
			: body;
	return { status: response.status, body, health };
};

const assertHealthEventually = (
	url,
	{ label, expectedStatus, expectedOk, headers, timeoutMs = 45_000 } = {},
) =>
	poll(
		async () => {
			const result = await readHealthResponse(url, headers);
			assert.notEqual(
				result.status,
				404,
				`${label ?? url} health endpoint가 404를 반환했습니다.`,
			);
			const expectedStatuses = Array.isArray(expectedStatus)
				? expectedStatus
				: [expectedStatus];
			assert.ok(
				expectedStatuses.includes(result.status),
				`${label ?? url} status=${result.status}, expected=${expectedStatuses.join('|')}, body=${JSON.stringify(result.body)}`,
			);
			assert.equal(
				result.health?.ok,
				expectedOk,
				`${label ?? url} ok=${String(result.health?.ok)}, body=${JSON.stringify(result.body)}`,
			);
			return result.health;
		},
		{ timeoutMs, intervalMs: 300 },
	);

const assertServiceUnavailableButLive = (baseUrl, label) =>
	Promise.all([
		assertHealthEventually(`${baseUrl}/health/live`, {
			label: `${label} live`,
			expectedStatus: 200,
			expectedOk: true,
		}),
		assertHealthEventually(`${baseUrl}/health/ready`, {
			label: `${label} ready`,
			expectedStatus: 503,
			expectedOk: false,
		}),
	]);

const assertServiceReady = (baseUrl, label, timeoutMs = 60_000) =>
	assertHealthEventually(`${baseUrl}/health/ready`, {
		label: `${label} ready recovery`,
		expectedStatus: 200,
		expectedOk: true,
		timeoutMs,
	});

const assertTelemetryTopLevelHealth = (expectedOk, label) =>
	assertHealthEventually(`${appBaseUrls.telemetry}/api/admin/health`, {
		label,
		expectedStatus: [200, 503],
		expectedOk,
		headers: adminHeaders,
		timeoutMs: 60_000,
	});

const proveRequiredUpstreamHealth = async ({
	cacheBaseUrl,
	cacheReplicaBaseUrl,
}) => {
	const startedAt = Date.now();
	let replacementStarted = false;
	await stopChild(resizeChild);

	try {
		await Promise.all([
			assertServiceUnavailableButLive(cacheBaseUrl, 'cache resize outage'),
			assertServiceUnavailableButLive(
				cacheReplicaBaseUrl,
				'cache replica resize outage',
			),
		]);

		await startResizeApplication();
		replacementStarted = true;
		await Promise.all([
			assertServiceReady(cacheBaseUrl, 'cache resize recovery'),
			assertServiceReady(cacheReplicaBaseUrl, 'cache replica resize recovery'),
		]);
		console.log(
			`System E2E required upstream health 복구 통과: cache live=200, ready=503->200, ${Date.now() - startedAt}ms`,
		);
	} finally {
		if (!replacementStarted) {
			await stopChild(resizeChild);
			await startResizeApplication();
		}
	}
};

const proveKafkaOutageHealth = async () => {
	const startedAt = Date.now();
	let kafkaStopped = false;
	const affectedServices = Object.entries(appBaseUrls);

	try {
		await stopInfrastructureService(infrastructure, 'kafka');
		kafkaStopped = true;
		await Promise.all([
			...affectedServices.map(([name, baseUrl]) =>
				assertServiceUnavailableButLive(baseUrl, `${name} Kafka outage`),
			),
			assertTelemetryTopLevelHealth(false, 'telemetry top-level Kafka outage'),
		]);

		await startInfrastructureService(infrastructure, 'kafka');
		kafkaStopped = false;
		await Promise.all([
			...affectedServices.map(([name, baseUrl]) =>
				assertServiceReady(baseUrl, `${name} Kafka recovery`, 90_000),
			),
			assertTelemetryTopLevelHealth(true, 'telemetry top-level Kafka recovery'),
		]);
		console.log(
			`System E2E Kafka health 복구 통과: live=200, ready=503->200, telemetry ok=false->true, ${Date.now() - startedAt}ms`,
		);
	} finally {
		if (kafkaStopped) {
			await startInfrastructureService(infrastructure, 'kafka');
		}
	}
};

const provePoisonDlqProgress = async ({ telemetryBaseUrl }) => {
	const startedAt = Date.now();
	const poisonRaw = Buffer.from(`{broken-system-e2e-${process.pid}`);
	const poisonRecord = await produceKafkaValue({
		broker: infrastructure.kafkaBroker,
		topic: telemetryTopic,
		key: `poison-${process.pid}`,
		value: poisonRaw,
	});
	const validEvent = createTelemetryProbeEvent('after-poison');
	await produceKafkaValue({
		broker: infrastructure.kafkaBroker,
		topic: telemetryTopic,
		key: validEvent.eventId,
		value: Buffer.from(JSON.stringify(validEvent)),
	});

	const envelope = await consumeKafkaJson({
		broker: infrastructure.kafkaBroker,
		topic: telemetryDlqTopic,
		label: `poison DLQ ${poisonRecord.partition}:${poisonRecord.offset}`,
		predicate: (candidate) =>
			candidate?.sourceTopic === telemetryTopic &&
			candidate?.partition === poisonRecord.partition &&
			candidate?.offset === poisonRecord.offset,
	});
	assert.equal(envelope.rawPayload, poisonRaw.toString('base64'));
	assert.equal(envelope.rawPayloadEncoding, 'base64');
	assert.match(envelope.error, /valid JSON/i);
	assert.equal(envelope.sourceTopic, telemetryTopic);
	assert.equal(envelope.partition, poisonRecord.partition);
	assert.equal(envelope.offset, poisonRecord.offset);

	await assertTelemetryEventEventually(telemetryBaseUrl, validEvent.eventId);
	console.log(
		`System E2E Kafka poison 복구 통과: dlq=${telemetryDlqTopic}@${poisonRecord.partition}:${poisonRecord.offset}, subsequent=${validEvent.eventId}, ${Date.now() - startedAt}ms`,
	);
};

const proveDatabaseOutageRedelivery = async ({ telemetryBaseUrl }) => {
	const startedAt = Date.now();
	const validEvent = createTelemetryProbeEvent('postgres-outage');
	const logStart = telemetryChild?.capturedLines?.length ?? 0;
	const storageLogStart = storageChild?.capturedLines?.length ?? 0;
	const outboxProbe = await enqueueLifecycleOutboxProbe();
	let postgresStopped = false;

	try {
		await stopInfrastructureService(infrastructure, 'postgres');
		postgresStopped = true;
		await Promise.all([
			...Object.entries(appBaseUrls).map(([name, baseUrl]) =>
				assertServiceUnavailableButLive(baseUrl, `${name} PostgreSQL outage`),
			),
			assertTelemetryTopLevelHealth(
				false,
				'telemetry top-level PostgreSQL outage',
			),
		]);
		const record = await produceKafkaValue({
			broker: infrastructure.kafkaBroker,
			topic: telemetryTopic,
			key: validEvent.eventId,
			value: Buffer.from(JSON.stringify(validEvent)),
		});

		await poll(
			async () => {
				const recentLogs =
					telemetryChild?.capturedLines?.slice(logStart).join('\n') ?? '';
				assert.match(
					recentLogs,
					/(eachMessage|insert_failed|database|P1001|connection)/i,
					'telemetry consumer가 PostgreSQL 중단 중 message 처리를 시도하지 않았습니다.',
				);
			},
			{ timeoutMs: 20_000, intervalMs: 250 },
		);
		await poll(
			async () => {
				assert.equal(storageChild?.exitCode, null);
				assert.equal(storageChild?.signalCode, null);
				const recentLogs =
					storageChild?.capturedLines?.slice(storageLogStart).join('\n') ?? '';
				assert.match(
					recentLogs,
					/image_lifecycle_outbox_background_task_failed/,
					'storage outbox scheduler가 PostgreSQL 중단 오류를 관찰하지 않았습니다.',
				);
			},
			{ timeoutMs: 20_000, intervalMs: 250 },
		);

		const committedDuringOutage = await fetchConsumerGroupOffset({
			broker: infrastructure.kafkaBroker,
			groupId: telemetryKafkaGroupId,
			topic: telemetryTopic,
			partition: record.partition,
		});
		assert.ok(
			BigInt(committedDuringOutage) <= BigInt(record.offset),
			`PostgreSQL 저장 전 offset이 선행 commit되었습니다: committed=${committedDuringOutage}, message=${record.offset}`,
		);

		await startInfrastructureService(infrastructure, 'postgres');
		postgresStopped = false;
		await Promise.all([
			...Object.entries(appBaseUrls).map(([name, baseUrl]) =>
				assertServiceReady(baseUrl, `${name} PostgreSQL recovery`, 90_000),
			),
			assertTelemetryTopLevelHealth(
				true,
				'telemetry top-level PostgreSQL recovery',
			),
		]);
		await assertTelemetryEventEventually(telemetryBaseUrl, validEvent.eventId, {
			timeoutMs: 45_000,
		});
		await assertLifecycleOutboxPublishedEventually(outboxProbe.id, {
			timeoutMs: 45_000,
		});
		const resumedLifecycleEvent = await consumeKafkaEvent({
			broker: infrastructure.kafkaBroker,
			topic: lifecycleTopic,
			eventId: outboxProbe.event.eventId,
		});
		assert.equal(resumedLifecycleEvent.eventId, outboxProbe.event.eventId);
		assert.equal(storageChild?.exitCode, null);
		assert.equal(storageChild?.signalCode, null);
		await poll(
			async () => {
				const committedAfterRecovery = await fetchConsumerGroupOffset({
					broker: infrastructure.kafkaBroker,
					groupId: telemetryKafkaGroupId,
					topic: telemetryTopic,
					partition: record.partition,
				});
				assert.ok(
					BigInt(committedAfterRecovery) >= BigInt(record.offset) + 1n,
					`복구 후 offset이 commit되지 않았습니다: committed=${committedAfterRecovery}, message=${record.offset}`,
				);
			},
			{ timeoutMs: 20_000, intervalMs: 300 },
		);
		console.log(
			`System E2E PostgreSQL redelivery/storage outbox/health 복구 통과: live=200, ready=503->200, telemetry ok=false->true, event=${validEvent.eventId}, outbox=${outboxProbe.event.eventId}, outageCommit=${committedDuringOutage}, message=${record.offset}, ${Date.now() - startedAt}ms`,
		);
	} finally {
		if (postgresStopped) {
			await startInfrastructureService(infrastructure, 'postgres');
		}
	}
};

const enqueueLifecycleOutboxProbe = async () => {
	const eventId = `system-e2e-outbox-recovery-${process.pid}-${Date.now()}`;
	const event = {
		schemaVersion: 1,
		eventId,
		eventType: 'image.upload.completed',
		occurredAt: new Date().toISOString(),
		sourceApp: 'storage',
		environment: 'test',
		path: 'system-e2e/outbox-recovery',
		name: `${eventId}.png`,
		imageKey: `system-e2e/outbox-recovery/${eventId}.png`,
		format: 'png',
		inputBytes: 1,
		outputBytes: 1,
		durationMs: 1,
		status: 'success',
	};
	const id = `system-e2e-outbox-${process.pid}-${Date.now()}`;
	await withPostgreSqlClient((client) =>
		client.query(
			`insert into image_lifecycle_outbox
				(id, event_id, topic, kafka_key, payload, status, next_attempt_at, created_at, updated_at)
			 values ($1, $2, $3, $4, $5::jsonb, 'PENDING', now() + interval '2 seconds', now(), now())`,
			[
				id,
				eventId,
				lifecycleTopic,
				`system-e2e:${event.imageKey}:${event.eventType}`,
				JSON.stringify(event),
			],
		),
	);
	return { id, event };
};

const assertLifecycleOutboxPublishedEventually = (id, options = {}) =>
	poll(async () => {
		const result = await withPostgreSqlClient((client) =>
			client.query(
				'select status, published_at from image_lifecycle_outbox where id = $1',
				[id],
			),
		);
		assert.equal(result.rows[0]?.status, 'PUBLISHED');
		assert.ok(result.rows[0]?.published_at);
	}, options);

const withPostgreSqlClient = async (operation) => {
	const client = new PostgreSqlClient({
		connectionString: infrastructure.databaseUrl,
	});
	await client.connect();
	try {
		return await operation(client);
	} finally {
		await client.end();
	}
};

const createTelemetryProbeEvent = (suffix) => {
	const eventId = `system-e2e-${suffix}-${process.pid}-${Date.now()}`;
	return {
		schemaVersion: 1,
		eventId,
		eventType: 'image.read.completed',
		occurredAt: new Date().toISOString(),
		sourceApp: 'storage',
		environment: 'test',
		path: 'system-e2e/resilience',
		name: `${eventId}.png`,
		imageKey: `system-e2e/resilience/${eventId}.png`,
		status: 'success',
	};
};

const assertTelemetryEventEventually = (
	telemetryBaseUrl,
	eventId,
	options = {},
) =>
	poll(async () => {
		const result = await fetchJson(
			`${telemetryBaseUrl}/api/admin/events?limit=100`,
			{ headers: adminHeaders },
		);
		assert.ok(
			result.items.some((event) => event.eventId === eventId),
			`telemetry event가 PostgreSQL에 저장되지 않았습니다: ${eventId}`,
		);
	}, options);

const createKafkaClient = (broker, clientId) =>
	new Kafka({
		clientId,
		brokers: [broker],
		logLevel: logLevel.NOTHING,
	});

const produceKafkaValue = async ({ broker, topic, key, value }) => {
	const producer = createKafkaClient(
		broker,
		`system-e2e-producer-${process.pid}-${Date.now()}`,
	).producer();
	await producer.connect();
	try {
		const [metadata] = await producer.send({
			topic,
			acks: -1,
			messages: [{ key, value }],
		});
		return { partition: metadata.partition, offset: metadata.baseOffset };
	} finally {
		await producer.disconnect();
	}
};

const fetchConsumerGroupOffset = async ({
	broker,
	groupId,
	topic,
	partition,
}) => {
	const admin = createKafkaClient(
		broker,
		`system-e2e-offsets-${process.pid}-${Date.now()}`,
	).admin();
	await admin.connect();
	try {
		const offsets = await admin.fetchOffsets({ groupId, topics: [topic] });
		const topicOffsets = offsets.find((entry) => entry.topic === topic);
		const partitionOffset = topicOffsets?.partitions.find(
			(entry) => entry.partition === partition,
		);
		assert.ok(
			partitionOffset,
			`consumer group offset을 찾지 못했습니다: ${groupId}/${topic}/${partition}`,
		);
		return partitionOffset.offset;
	} finally {
		await admin.disconnect();
	}
};

const consumeKafkaJson = async ({ broker, topic, label, predicate }) => {
	const consumer = createKafkaClient(
		broker,
		`system-e2e-consumer-${process.pid}-${Date.now()}`,
	).consumer({
		groupId: `system-e2e-consumer-${process.pid}-${Date.now()}`,
	});
	await consumer.connect();
	await consumer.subscribe({ topic, fromBeginning: true });
	try {
		return await new Promise((resolveValue, rejectValue) => {
			const timeout = setTimeout(
				() => rejectValue(new Error(`Kafka event timeout: ${label}`)),
				20_000,
			);
			void consumer
				.run({
					eachMessage: async ({ message }) => {
						if (!message.value) return;
						const value = JSON.parse(message.value.toString('utf8'));
						if (predicate(value)) {
							clearTimeout(timeout);
							resolveValue(value);
						}
					},
				})
				.catch((error) => {
					clearTimeout(timeout);
					rejectValue(error);
				});
		});
	} finally {
		await consumer.disconnect();
	}
};

const consumeKafkaEvent = async ({ broker, topic, eventId }) => {
	const kafka = createKafkaClient(
		broker,
		`system-e2e-client-lifecycle-${process.pid}`,
	);
	const consumer = kafka.consumer({
		groupId: `system-e2e-client-lifecycle-${process.pid}-${Date.now()}`,
	});
	await consumer.connect();
	await consumer.subscribe({ topic, fromBeginning: true });
	try {
		return await new Promise((resolveEvent, rejectEvent) => {
			const timeout = setTimeout(
				() =>
					rejectEvent(new Error(`client lifecycle event timeout: ${topic}`)),
				20_000,
			);
			void consumer
				.run({
					eachMessage: async ({ message }) => {
						if (!message.value) {
							return;
						}
						const event = JSON.parse(message.value.toString('utf8'));
						if (event.eventId === eventId) {
							clearTimeout(timeout);
							resolveEvent(event);
						}
					},
				})
				.catch((error) => {
					clearTimeout(timeout);
					rejectEvent(error);
				});
		});
	} finally {
		await consumer.disconnect();
	}
};

let failed = false;
try {
	if (process.env.SYSTEM_E2E_SKIP_BUILD !== '1') {
		await run('pnpm', [
			'turbo',
			'run',
			'build',
			'--filter=@file/storage',
			'--filter=@file/resize',
			'--filter=@file/cache',
			'--filter=@file/telemetry-api',
		]);
	}
	await startInfrastructure(infrastructure);
	await migrateDatabase(infrastructure);
	await startApplications();
	await runScenario();
} catch (error) {
	failed = true;
	console.error(error);
	printChildLogs(children);
} finally {
	for (const child of children.reverse()) {
		await stopChild(child);
	}
	if (process.env.SYSTEM_E2E_KEEP_INFRA !== '1') {
		await stopInfrastructure(infrastructure);
	}
}

if (failed) {
	process.exitCode = 1;
}
