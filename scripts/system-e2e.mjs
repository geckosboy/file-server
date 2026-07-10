import assert from 'node:assert/strict';

import {
	createInfrastructureConfig,
	fetchJson,
	getFreePort,
	migrateDatabase,
	poll,
	printChildLogs,
	run,
	spawnService,
	startInfrastructure,
	stopChild,
	stopInfrastructure,
	waitForHttp,
} from './system-test-utils.mjs';

const resolvePort = async (environmentName) =>
	Number(process.env[environmentName] || (await getFreePort()));
const appPorts = {
	telemetry: await resolvePort('SYSTEM_E2E_TELEMETRY_PORT'),
	cache: await resolvePort('SYSTEM_E2E_CACHE_PORT'),
	cacheReplica: await resolvePort('SYSTEM_E2E_CACHE_REPLICA_PORT'),
	resize: await resolvePort('SYSTEM_E2E_RESIZE_PORT'),
	storage: await resolvePort('SYSTEM_E2E_STORAGE_PORT'),
};
const adminToken = 'system-e2e-admin-token';
const internalApiKey = 'system-e2e-internal-key';
const clientApiKeyPepper = 'system-e2e-client-pepper';
const origin = 'http://127.0.0.1:43199';
const children = [];
const infrastructure = await createInfrastructureConfig('system-e2e');

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
			TELEMETRY_KAFKA_GROUP_ID: `system-e2e-telemetry-${process.pid}`,
			LIFECYCLE_KAFKA_CONSUMER_ENABLED: 'true',
			LIFECYCLE_KAFKA_FROM_BEGINNING: 'true',
			LIFECYCLE_KAFKA_GROUP_ID: `system-e2e-lifecycle-${process.pid}`,
		},
	});
	children.push(telemetry);
	await waitForHttp(`http://127.0.0.1:${appPorts.telemetry}/api/admin/health`, {
		headers: adminHeaders,
		child: telemetry,
		timeoutMs: 45_000,
	});

	const storage = spawnService({
		name: 'storage',
		entry: 'apps/storage/dist/apps/storage/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(appPorts.storage),
			CACHE_SERVER: `http://127.0.0.1:${appPorts.cache}`,
			LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS: '250',
		},
	});
	children.push(storage);
	await waitForHttp(`http://127.0.0.1:${appPorts.storage}/health-check`, {
		child: storage,
		timeoutMs: 45_000,
	});

	const resize = spawnService({
		name: 'resize',
		entry: 'apps/resize/dist/apps/resize/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(appPorts.resize),
			STORAGE_SERVER: `http://127.0.0.1:${appPorts.storage}`,
		},
	});
	children.push(resize);
	await waitForHttp(`http://127.0.0.1:${appPorts.resize}/health-check`, {
		child: resize,
		timeoutMs: 45_000,
	});

	const cache = spawnService({
		name: 'cache',
		entry: 'apps/cache/dist/apps/cache/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(appPorts.cache),
			RESIZING_SERVER: `http://127.0.0.1:${appPorts.resize}`,
		},
	});
	children.push(cache);
	await waitForHttp(`http://127.0.0.1:${appPorts.cache}/health-check`, {
		child: cache,
		timeoutMs: 45_000,
	});

	const cacheReplica = spawnService({
		name: 'cache-replica',
		entry: 'apps/cache/dist/apps/cache/src/main.js',
		env: {
			...commonAppEnv,
			PORT: String(appPorts.cacheReplica),
			RESIZING_SERVER: `http://127.0.0.1:${appPorts.resize}`,
		},
	});
	children.push(cacheReplica);
	await waitForHttp(`http://127.0.0.1:${appPorts.cacheReplica}/health-check`, {
		child: cacheReplica,
		timeoutMs: 45_000,
	});
};

const runScenario = async () => {
	const telemetryBaseUrl = `http://127.0.0.1:${appPorts.telemetry}`;
	const storageBaseUrl = `http://127.0.0.1:${appPorts.storage}`;
	const cacheBaseUrl = `http://127.0.0.1:${appPorts.cache}`;
	const cacheReplicaBaseUrl = `http://127.0.0.1:${appPorts.cacheReplica}`;

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

	console.log(
		`System E2E 통과: upload=${uploadBody.imageKey}, cross-tenant 403, shared replica rate-limit 429, cache/resize/storage chain, telemetry, lifecycle`,
	);
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
