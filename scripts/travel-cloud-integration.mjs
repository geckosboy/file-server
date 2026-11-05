import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Kafka, logLevel } from 'kafkajs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(
	repoRoot,
	'docker/docker-compose.travel-cloud-integration.yml',
);
const runtimeDirectory = resolve(repoRoot, '.tmp/travel-cloud-integration');
const runtimeStateFile = resolve(runtimeDirectory, 'runtime.json');
const runtimeEnvFile = resolve(runtimeDirectory, 'travel-cloud.env');
const project =
	process.env.TRAVEL_CLOUD_INTEGRATION_PROJECT ?? 'file-server-travel-cloud';
const proxyPort = process.env.TRAVEL_CLOUD_PROXY_HOST_PORT ?? '18088';
const telemetryPort = process.env.TRAVEL_CLOUD_TELEMETRY_HOST_PORT ?? '13100';
const kafkaPort = process.env.TRAVEL_CLOUD_KAFKA_HOST_PORT ?? '39094';
const kafkaAdvertisedHost =
	process.env.TRAVEL_CLOUD_KAFKA_ADVERTISED_HOST ?? 'localhost';
const proxyAdvertisedHost =
	process.env.TRAVEL_CLOUD_PROXY_ADVERTISED_HOST ?? '127.0.0.1';
const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;
const adminBaseUrl = `http://127.0.0.1:${telemetryPort}/api/admin`;
const adminToken = 'travel-cloud-admin-token';
const serviceSlug = 'travel-cloud';
const namespace = 'travel-cloud/image';
const consumerGroup = 'travel-cloud-file-lifecycle-v1';
const lifecycleEventTypes = [
	'image.upload.completed',
	'image.upload.failed',
	'image.delete.completed',
	'image.delete.failed',
];
const samplePng = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVR4nGMQqbgDRww4OQA/5hDhi4IkywAAAABJRU5ErkJggg==',
	'base64',
);

const action = process.argv[2] ?? 'help';

const sleep = (milliseconds) =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const run = (command, args, options = {}) =>
	new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? repoRoot,
			env: options.env ?? process.env,
			stdio: options.stdio ?? 'inherit',
		});
		if (options.input !== undefined) child.stdin.end(options.input);
		child.once('error', rejectRun);
		child.once('exit', (code, signal) => {
			if (code === 0) return resolveRun();
			rejectRun(
				new Error(
					`${command} ${args.join(' ')} failed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
				),
			);
		});
	});

const runCapture = (command, args, options = {}) =>
	new Promise((resolveRun, rejectRun) => {
		const stdout = [];
		const stderr = [];
		const child = spawn(command, args, {
			cwd: options.cwd ?? repoRoot,
			env: options.env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		if (options.input !== undefined) child.stdin.end(options.input);
		else child.stdin.end();
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.once('error', rejectRun);
		child.once('exit', (code, signal) => {
			const output = Buffer.concat(stdout).toString('utf8');
			const errorOutput = Buffer.concat(stderr).toString('utf8');
			const result = {
				code,
				signal,
				stdout: output,
				stderr: errorOutput,
				combined: `${output}\n${errorOutput}`.trim(),
			};
			if (code === 0 || options.allowFailure) return resolveRun(result);
			rejectRun(
				new Error(
					`${command} ${args.join(' ')} failed (code=${code ?? 'null'}): ${errorOutput.trim()}`,
				),
			);
		});
	});

const composeArgs = (...args) => ['compose', '-f', composeFile, ...args];

const waitForHttp = async (url, timeoutMs = 90_000) => {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return response;
			lastError = new Error(`${url} returned ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await sleep(500);
	}
	throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? ''}`);
};

const readRuntimeState = async () => {
	try {
		return JSON.parse(await readFile(runtimeStateFile, 'utf8'));
	} catch (error) {
		if (error?.code === 'ENOENT') return undefined;
		throw error;
	}
};

const adminRequest = async (path, options = {}) => {
	const response = await fetch(`${adminBaseUrl}${path}`, {
		...options,
		headers: {
			'content-type': 'application/json',
			'x-admin-token': adminToken,
			'x-admin-actor': 'travel-cloud-integration-harness',
			'x-request-id': `travel-cloud-provision-${Date.now()}`,
			...options.headers,
		},
	});
	const body = await response.text();
	if (!response.ok) {
		throw new Error(
			`${options.method ?? 'GET'} ${path} returned ${response.status}: ${body}`,
		);
	}
	return body ? JSON.parse(body) : undefined;
};

const printEndpoints = () => {
	console.log('Travel Cloud integration endpoints');
	console.log(`  reverse proxy: ${proxyBaseUrl}/file-server`);
	console.log(`  telemetry admin (localhost only): ${adminBaseUrl}`);
	console.log(`  Kafka: localhost:${kafkaPort}`);
	console.log(`  runtime credentials: ${runtimeEnvFile}`);
};

const up = async () => {
	await run('docker', ['info'], { stdio: 'ignore' });
	try {
		await run('docker', [
			...composeArgs('up'),
			'--detach',
			'--build',
			'--wait',
			'--wait-timeout',
			'420',
		]);
		await waitForHttp(`${proxyBaseUrl}/health/live`);
		await waitForHttp(`http://127.0.0.1:${telemetryPort}/health/live`);
		printEndpoints();
	} catch (error) {
		await run('docker', [...composeArgs('ps')]).catch(() => undefined);
		await run('docker', [...composeArgs('logs'), '--tail=200']).catch(
			() => undefined,
		);
		throw error;
	}
};

const provision = async () => {
	await waitForHttp(`http://127.0.0.1:${telemetryPort}/health/live`);
	const previousState = await readRuntimeState();
	const services = await adminRequest('/client-services');
	let service = services.find((candidate) => candidate.slug === serviceSlug);
	if (!service) {
		service = await adminRequest('/client-services', {
			method: 'POST',
			body: JSON.stringify({
				slug: serviceSlug,
				name: 'Travel Cloud',
				owner: 'travel-cloud-integration',
				description: 'Docker integration harness client service',
			}),
		});
	}

	let detail = await adminRequest(`/client-services/${service.id}`);
	if (!detail.policies?.some((policy) => policy.pathPattern === namespace)) {
		await adminRequest(`/client-services/${service.id}/policies`, {
			method: 'POST',
			body: JSON.stringify({
				pathPattern: namespace,
				canRead: true,
				canUpload: true,
				canDelete: true,
				maxUploadBytes: 20 * 1024 * 1024,
				rateLimitPerMin: 300,
				metadata: { harness: 'travel-cloud' },
			}),
		});
	}

	let apiKey =
		previousState?.clientServiceId === service.id
			? previousState.apiKey
			: undefined;
	if (!apiKey) {
		const keyResult = await adminRequest(
			`/client-services/${service.id}/keys`,
			{
				method: 'POST',
				body: JSON.stringify({
					name: 'travel-cloud-integration',
					scopes: {
						actions: ['read', 'upload', 'delete'],
						pathPatterns: [namespace],
					},
				}),
			},
		);
		apiKey = keyResult.apiKey;
	}

	const kafkaPassword =
		previousState?.clientServiceId === service.id
			? previousState.kafkaPassword
			: randomBytes(24).toString('base64url');
	assert(kafkaPassword, 'Kafka password must be available');

	await run(
		'bash',
		[
			'scripts/kafka/provision-client-lifecycle-topic.sh',
			'prod',
			service.id,
			consumerGroup,
		],
		{
			env: {
				...process.env,
				KAFKA_COMPOSE_FILE: composeFile,
				KAFKA_TOPIC_SERVICE: 'kafka',
				KAFKA_TOPIC_BOOTSTRAP: 'kafka:9092',
				KAFKA_TOPIC_COMMAND_CONFIG: '/etc/kafka/client-config/admin.properties',
				KAFKA_TOPIC_PARTITIONS: '1',
				KAFKA_TOPIC_REPLICATION_FACTOR: '1',
				KAFKA_TOPIC_MIN_ISR: '1',
				KAFKA_CLIENT_PRINCIPAL_PASSWORD: kafkaPassword,
			},
		},
	);

	for (const eventType of lifecycleEventTypes) {
		detail = await adminRequest(`/client-services/${service.id}`);
		const current = detail.lifecycleSubscriptions?.find(
			(subscription) => subscription.eventType === eventType,
		);
		const payload = JSON.stringify({
			eventType,
			consumerGroup,
			isEnabled: true,
			description: `Travel Cloud ${eventType}`,
		});
		const subscription = current
			? await adminRequest(
					`/client-services/${service.id}/lifecycle-subscriptions/${current.id}`,
					{ method: 'PATCH', body: payload },
				)
			: await adminRequest(
					`/client-services/${service.id}/lifecycle-subscriptions`,
					{ method: 'POST', body: payload },
				);
		assert.equal(
			subscription.provisioningStatus,
			'PROVISIONED',
			`${eventType} subscription was not provisioned: ${subscription.provisioningError ?? 'unknown'}`,
		);
	}

	detail = await adminRequest(`/client-services/${service.id}`);
	const expectedTopic = `file.image.lifecycle.client.${service.id.toLowerCase()}.v1`;
	const expectedUsername = `file-lifecycle-${service.id.toLowerCase()}`;
	for (const subscription of detail.lifecycleSubscriptions ?? []) {
		if (!lifecycleEventTypes.includes(subscription.eventType)) continue;
		assert.equal(subscription.topic, expectedTopic);
		assert.equal(subscription.principal, `User:${expectedUsername}`);
		assert.equal(subscription.consumerGroup, consumerGroup);
		assert.equal(subscription.provisioningStatus, 'PROVISIONED');
	}

	const state = {
		generatedAt: new Date().toISOString(),
		proxyBaseUrl: `http://${proxyAdvertisedHost}:${proxyPort}/file-server`,
		adminBaseUrl,
		clientServiceId: service.id,
		clientServiceSlug: serviceSlug,
		namespace,
		apiKey,
		kafkaBrokers: `${kafkaAdvertisedHost}:${kafkaPort}`,
		kafkaSecurityProtocol: 'SASL_PLAINTEXT',
		kafkaSaslMechanism: 'SCRAM-SHA-512',
		kafkaUsername: expectedUsername,
		kafkaPassword,
		kafkaTopic: expectedTopic,
		kafkaConsumerGroup: consumerGroup,
	};
	await mkdir(runtimeDirectory, { recursive: true });
	await writeFile(runtimeStateFile, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
	await writeFile(
		runtimeEnvFile,
		[
			'# pnpm integration:travel-cloud:provision이 생성한 파일입니다.',
			'# 로컬 통합 secret입니다. commit하거나 운영에서 재사용하지 마세요.',
			'# pnpm integration:travel-cloud:down 실행 시 삭제됩니다.',
			'',
			'# Nginx reverse proxy base URL입니다. upload/delete는 /images, read는 /images/:path/:name을 붙입니다.',
			`TRAVEL_FILE_SERVER_BASE_URL=${state.proxyBaseUrl}`,
			'# Travel Cloud Client Service API key입니다. backend에서만 x-client-api-key 또는 Bearer token으로 보냅니다.',
			`TRAVEL_FILE_SERVER_API_KEY=${state.apiKey}`,
			'# canonical storage policy namespace입니다. upload multipart path에는 그대로 쓰고 read URL에서는 마지막 /image를 제외합니다.',
			`TRAVEL_FILE_SERVER_NAMESPACE=${state.namespace}`,
			'# 서버가 발급한 Client Service primary key로 metadata/event/topic/principal 소유권을 식별합니다.',
			`TRAVEL_FILE_SERVER_CLIENT_SERVICE_ID=${state.clientServiceId}`,
			'',
			'# Travel Cloud 프로세스에서 접근 가능한 쉼표 구분 Kafka bootstrap broker 목록입니다.',
			`TRAVEL_KAFKA_BROKERS=${state.kafkaBrokers}`,
			'# 로컬 하네스의 Kafka transport입니다. 운영에서는 SASL_SSL을 사용해야 합니다.',
			`TRAVEL_KAFKA_SECURITY_PROTOCOL=${state.kafkaSecurityProtocol}`,
			'# 발급된 client principal의 SASL 인증 방식입니다.',
			`TRAVEL_KAFKA_SASL_MECHANISM=${state.kafkaSaslMechanism}`,
			'# SCRAM username이며 Kafka principal은 User:<이 값>입니다.',
			`TRAVEL_KAFKA_USERNAME=${state.kafkaUsername}`,
			'# 자동 생성된 SCRAM password입니다. secret으로 취급하고 로그에 남기지 않습니다.',
			`TRAVEL_KAFKA_PASSWORD=${state.kafkaPassword}`,
			'# 이 principal이 READ/DESCRIBE할 수 있는 유일한 lifecycle topic입니다.',
			`TRAVEL_KAFKA_TOPIC=${state.kafkaTopic}`,
			'# 이 principal이 사용할 수 있는 유일한 consumer group입니다. 업무 처리 성공 뒤 offset을 commit합니다.',
			`TRAVEL_KAFKA_CONSUMER_GROUP=${state.kafkaConsumerGroup}`,
			'',
		].join('\n'),
		{ mode: 0o600 },
	);
	await chmod(runtimeStateFile, 0o600);
	await chmod(runtimeEnvFile, 0o600);

	console.log('Travel Cloud provisioning: PASS');
	console.log(`  clientServiceId: ${state.clientServiceId}`);
	console.log(`  topic: ${state.kafkaTopic}`);
	console.log(`  principal: User:${state.kafkaUsername}`);
	console.log(`  consumerGroup: ${state.kafkaConsumerGroup}`);
	console.log(`  credentials: ${runtimeEnvFile}`);
	return state;
};

const kafkaExec = (args, options = {}) =>
	runCapture(
		'docker',
		[...composeArgs('exec'), '--no-TTY', 'kafka', ...args],
		options,
	);

const writeKafkaClientConfig = async (state) => {
	const config = [
		'security.protocol=SASL_PLAINTEXT',
		'sasl.mechanism=SCRAM-SHA-512',
		`sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="${state.kafkaUsername}" password="${state.kafkaPassword}";`,
		'',
	].join('\n');
	await kafkaExec(
		['/bin/bash', '-ec', 'cat > /tmp/travel-cloud-client.properties'],
		{
			input: config,
		},
	);
};

const consumeLifecycleEvent = async (state, eventType) => {
	const kafka = new Kafka({
		clientId: `travel-cloud-harness-${eventType.replaceAll('.', '-')}`,
		brokers: state.kafkaBrokers.split(','),
		ssl: false,
		sasl: {
			mechanism: 'scram-sha-512',
			username: state.kafkaUsername,
			password: state.kafkaPassword,
		},
		logLevel: logLevel.NOTHING,
	});
	const consumer = kafka.consumer({ groupId: state.kafkaConsumerGroup });
	let timeout;
	try {
		await consumer.connect();
		await consumer.subscribe({ topic: state.kafkaTopic, fromBeginning: true });
		const received = new Promise((resolveReceived, rejectReceived) => {
			timeout = setTimeout(
				() => rejectReceived(new Error(`Timed out waiting for ${eventType}`)),
				30_000,
			);
			void consumer
				.run({
					autoCommit: false,
					eachMessage: async ({ topic, partition, message }) => {
						const value = message.value?.toString('utf8') ?? '';
						if (!value.includes(`"eventType":"${eventType}"`)) return;
						await consumer.commitOffsets([
							{
								topic,
								partition,
								offset: String(Number(message.offset) + 1),
							},
						]);
						resolveReceived();
					},
				})
				.catch(rejectReceived);
		});
		await received;
	} finally {
		clearTimeout(timeout);
		await consumer.disconnect().catch(() => undefined);
	}
};

const expectKafkaDenied = async (description, args) => {
	const result = await kafkaExec(args, { allowFailure: true });
	if (
		!/TopicAuthorizationException|GroupAuthorizationException|not authorized|authorization failed/i.test(
			result.combined,
		)
	) {
		throw new Error(`${description} was not denied:\n${result.combined}`);
	}
	console.log(`  denied as expected: ${description}`);
};

const createUploadForm = () => {
	const form = new FormData();
	form.append('path', namespace);
	form.append(
		'file',
		new Blob([samplePng], { type: 'image/png' }),
		'travel-cloud-smoke.png',
	);
	return form;
};

const requestJson = async (url, options, expectedStatus) => {
	const response = await fetch(url, options);
	const body = await response.text();
	if (response.status !== expectedStatus) {
		throw new Error(
			`${options.method ?? 'GET'} ${url} returned ${response.status}: ${body}`,
		);
	}
	let parsedBody;
	if (body) {
		try {
			parsedBody = JSON.parse(body);
		} catch {
			parsedBody = body;
		}
	}
	return { response, body: parsedBody };
};

const smoke = async () => {
	const state = await readRuntimeState();
	if (!state)
		throw new Error(`Run provisioning first: ${runtimeStateFile} is missing`);
	await waitForHttp(`${proxyBaseUrl}/health/live`);
	await waitForHttp(`${proxyBaseUrl}/file-server/health/storage/ready`, 30_000);
	await waitForHttp(`${proxyBaseUrl}/file-server/health/cache/ready`, 30_000);
	await writeKafkaClientConfig(state);
	const smokeId = Date.now();

	const requestHeaders = {
		'x-client-api-key': state.apiKey,
		'x-request-id': `travel-cloud-smoke-${smokeId}`,
		'x-trace-id': `travel-cloud-trace-${smokeId}`,
		'Idempotency-Key': `travel-cloud-docker-smoke-${smokeId}`,
	};
	const uploadUrl = `${state.proxyBaseUrl}/images`;
	const firstUpload = await requestJson(
		uploadUrl,
		{ method: 'POST', headers: requestHeaders, body: createUploadForm() },
		201,
	);
	assert.equal(
		firstUpload.response.headers.get('x-file-server-proxy'),
		'nginx-travel-cloud',
	);
	for (const field of [
		'assetId',
		'imageKey',
		'name',
		'eventId',
		'variantStatus',
	]) {
		assert(firstUpload.body[field], `upload response is missing ${field}`);
	}
	const secondUpload = await requestJson(
		uploadUrl,
		{ method: 'POST', headers: requestHeaders, body: createUploadForm() },
		201,
	);
	assert.equal(secondUpload.body.assetId, firstUpload.body.assetId);
	assert.equal(secondUpload.body.imageKey, firstUpload.body.imageKey);
	assert.equal(secondUpload.body.eventId, firstUpload.body.eventId);

	const readUrl = `${state.proxyBaseUrl}/images/travel-cloud/${encodeURIComponent(firstUpload.body.name)}`;
	for (let index = 0; index < 2; index += 1) {
		const response = await fetch(readUrl, {
			headers: {
				'x-client-api-key': state.apiKey,
				'x-request-id': `travel-cloud-read-${index}`,
			},
		});
		assert.equal(response.status, 200);
		assert.equal(
			response.headers.get('x-file-server-proxy'),
			'nginx-travel-cloud',
		);
		assert((await response.arrayBuffer()).byteLength > 0);
	}

	await consumeLifecycleEvent(state, 'image.upload.completed');

	const otherTopic = 'file.image.lifecycle.client.travel-cloud-denied.v1';
	await kafkaExec([
		'/opt/kafka/bin/kafka-topics.sh',
		'--bootstrap-server',
		'kafka:9092',
		'--command-config',
		'/etc/kafka/client-config/admin.properties',
		'--create',
		'--if-not-exists',
		'--topic',
		otherTopic,
		'--partitions',
		'1',
		'--replication-factor',
		'1',
	]);
	const deniedConsumerBase = [
		'/opt/kafka/bin/kafka-console-consumer.sh',
		'--bootstrap-server',
		'kafka:9092',
		'--consumer.config',
		'/tmp/travel-cloud-client.properties',
		'--from-beginning',
		'--max-messages',
		'1',
		'--timeout-ms',
		'8000',
	];
	await expectKafkaDenied('canonical lifecycle topic', [
		...deniedConsumerBase,
		'--topic',
		'file.image.lifecycle.v1',
		'--group',
		state.kafkaConsumerGroup,
	]);
	await expectKafkaDenied('another client topic', [
		...deniedConsumerBase,
		'--topic',
		otherTopic,
		'--group',
		state.kafkaConsumerGroup,
	]);
	await expectKafkaDenied('unregistered consumer group', [
		...deniedConsumerBase,
		'--topic',
		state.kafkaTopic,
		'--group',
		`${state.kafkaConsumerGroup}-denied`,
	]);
	await expectKafkaDenied('produce to client topic', [
		'/bin/bash',
		'-ec',
		`printf '%s\\n' '{"eventId":"denied"}' | /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server kafka:9092 --producer.config /tmp/travel-cloud-client.properties --topic ${state.kafkaTopic}`,
	]);

	const deleteUrl = new URL(uploadUrl);
	deleteUrl.searchParams.set('imageKey', firstUpload.body.imageKey);
	await requestJson(
		deleteUrl,
		{
			method: 'DELETE',
			headers: {
				'x-client-api-key': state.apiKey,
				'x-request-id': 'travel-cloud-delete-smoke',
				'x-trace-id': 'travel-cloud-smoke',
			},
		},
		200,
	);
	await consumeLifecycleEvent(state, 'image.delete.completed');
	const afterDelete = await fetch(readUrl, {
		headers: { 'x-client-api-key': state.apiKey },
	});
	assert.equal(afterDelete.status, 404);

	console.log('Travel Cloud HTTP/Kafka integration smoke: PASS');
	console.log(`  assetId: ${firstUpload.body.assetId}`);
	console.log(`  imageKey: ${firstUpload.body.imageKey}`);
	console.log('  Nginx upload/read/delete routing: PASS');
	console.log('  idempotent upload retry: PASS');
	console.log('  lifecycle upload/delete delivery: PASS');
	console.log('  topic/group/produce isolation: PASS');
	console.log('  delete convergence to HTTP 404: PASS');
	return firstUpload.body;
};

const assertProjectResourcesRemoved = async () => {
	for (const [kind, args] of [
		[
			'containers',
			[
				'ps',
				'--quiet',
				'--filter',
				`label=com.docker.compose.project=${project}`,
			],
		],
		[
			'volumes',
			[
				'volume',
				'ls',
				'--quiet',
				'--filter',
				`label=com.docker.compose.project=${project}`,
			],
		],
		[
			'networks',
			[
				'network',
				'ls',
				'--quiet',
				'--filter',
				`label=com.docker.compose.project=${project}`,
			],
		],
	]) {
		const result = await runCapture('docker', args);
		assert.equal(
			result.stdout.trim(),
			'',
			`cleanup left ${kind}: ${result.stdout.trim()}`,
		);
	}
};

const removeLabelledProjectResources = async () => {
	const resources = [
		{
			list: [
				'ps',
				'--all',
				'--quiet',
				'--filter',
				`label=com.docker.compose.project=${project}`,
			],
			remove: ['rm', '--force'],
		},
		{
			list: [
				'volume',
				'ls',
				'--quiet',
				'--filter',
				`label=com.docker.compose.project=${project}`,
			],
			remove: ['volume', 'rm', '--force'],
		},
		{
			list: [
				'network',
				'ls',
				'--quiet',
				'--filter',
				`label=com.docker.compose.project=${project}`,
			],
			remove: ['network', 'rm'],
		},
	];
	for (const resource of resources) {
		const listed = await runCapture('docker', resource.list);
		const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
		if (ids.length > 0) {
			await run('docker', [...resource.remove, ...ids]);
		}
	}
};

const down = async () => {
	await run('docker', [
		...composeArgs('down'),
		'--volumes',
		'--remove-orphans',
		'--timeout',
		'5',
	]);
	await removeLabelledProjectResources();
	await rm(runtimeDirectory, { recursive: true, force: true });
	await assertProjectResourcesRemoved();
	console.log('Travel Cloud integration cleanup: PASS');
};

const verify = async () => {
	let failed = false;
	await down().catch(() => undefined);
	try {
		await up();
		await provision();
		await smoke();
	} catch (error) {
		failed = true;
		await run('docker', [...composeArgs('ps')]).catch(() => undefined);
		await run('docker', [...composeArgs('logs'), '--tail=250']).catch(
			() => undefined,
		);
		throw error;
	} finally {
		try {
			await down();
		} catch (error) {
			if (!failed) throw error;
			console.error(error);
		}
		if (!failed) console.log('Travel Cloud one-shot verification: PASS');
	}
};

const help = () => {
	console.log(`Usage: node scripts/travel-cloud-integration.mjs <command>

Commands:
  up         Build and start PostgreSQL, ACL Kafka, file apps, telemetry API and Nginx
  provision  Issue Travel Cloud service/key/policy/subscriptions and SCRAM credentials
  test       Run Nginx HTTP smoke and Kafka delivery/isolation assertions
  verify     Run an isolated up -> provision -> test -> cleanup cycle
  status     Show Docker Compose status and generated endpoints
  logs       Follow integration service logs
  down       Remove containers, network, volumes and generated credentials
`);
};

switch (action) {
	case 'up':
		await up();
		break;
	case 'provision':
		await provision();
		break;
	case 'test':
		await smoke();
		break;
	case 'verify':
		await verify();
		break;
	case 'status':
		await run('docker', [...composeArgs('ps')]);
		printEndpoints();
		break;
	case 'logs':
		await run('docker', [...composeArgs('logs'), '--follow', '--tail=200']);
		break;
	case 'down':
		await down();
		break;
	case 'help':
	case '--help':
	case '-h':
		help();
		break;
	default:
		help();
		process.exitCode = 64;
}
