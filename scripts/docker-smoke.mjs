import assert from 'node:assert/strict';

import {
	createInfrastructureConfig,
	getFreePort,
	migrateDatabase,
	run,
	runCapture,
	startInfrastructure,
	stopInfrastructure,
	waitForHttp,
} from './system-test-utils.mjs';

const infrastructure = await createInfrastructureConfig('docker-smoke');
const images = {
	storage: process.env.STORAGE_IMAGE ?? 'file-server/storage:local',
	resize: process.env.RESIZE_IMAGE ?? 'file-server/resize:local',
	cache: process.env.CACHE_IMAGE ?? 'file-server/cache:local',
};
const hostPorts = {
	storage: Number(
		process.env.DOCKER_SMOKE_STORAGE_PORT || (await getFreePort()),
	),
	resize: Number(process.env.DOCKER_SMOKE_RESIZE_PORT || (await getFreePort())),
	cache: Number(process.env.DOCKER_SMOKE_CACHE_PORT || (await getFreePort())),
};
const containerNames = Object.fromEntries(
	Object.keys(images).map((name) => [name, `fs-smoke-${name}-${process.pid}`]),
);
const commonEnv = {
	NODE_ENV: 'production',
	HOST: '0.0.0.0',
	ORIGIN_LIST_STR: 'http://127.0.0.1:43999',
	DATABASE_URL:
		'postgresql://file_server:file_server@postgres:5432/file_server',
	KAFKA_CLIENT_BROKERS: 'kafka:9092',
	CLIENT_API_KEY_PEPPER: 'docker-smoke-pepper',
	INTERNAL_API_KEY: 'docker-smoke-internal-key',
};

const envArgs = (environment) =>
	Object.entries(environment).flatMap(([name, value]) => [
		'--env',
		`${name}=${value}`,
	]);

const assertRuntimeImage = async (name, image) => {
	const version = await runCapture('docker', [
		'run',
		'--rm',
		'--entrypoint',
		'node',
		image,
		'--version',
	]);
	const match = /^v(\d+)\.(\d+)\./.exec(version);
	assert.ok(match, `${name} Node 버전을 해석할 수 없습니다: ${version}`);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	assert.ok(
		major > 22 || (major === 22 && minor >= 12),
		`${name}은 지원되지 않는 Node ${version}을 사용합니다.`,
	);

	const user = await runCapture('docker', [
		'image',
		'inspect',
		'--format',
		'{{.Config.User}}',
		image,
	]);
	assert.equal(
		user,
		'node',
		`${name} runtime은 non-root node 사용자여야 합니다.`,
	);

	const configuredEnv = await runCapture('docker', [
		'image',
		'inspect',
		'--format',
		'{{json .Config.Env}}',
		image,
	]);
	assert.doesNotMatch(
		configuredEnv,
		/(DATABASE_URL|CLIENT_API_KEY|ADMIN_TOKEN|INTERNAL_API_KEY|postgresql:\/\/)/i,
		`${name} image config에 비밀 설정이 포함되어 있습니다.`,
	);
};

const startContainer = async ({ name, image, port, environment }) => {
	await run('docker', [
		'run',
		'--detach',
		'--name',
		containerNames[name],
		'--network',
		infrastructure.network,
		'--network-alias',
		name,
		'--publish',
		`127.0.0.1:${hostPorts[name]}:${port}`,
		...envArgs({ ...commonEnv, ...environment }),
		image,
	]);
	await waitForHttp(`http://127.0.0.1:${hostPorts[name]}/health-check`, {
		timeoutMs: 45_000,
	});

	const envFiles = await runCapture('docker', [
		'exec',
		containerNames[name],
		'sh',
		'-c',
		"find /usr/index -type f \\( -name '.env' -o -name '.env.local' -o -name '.env.production' -o -name '.env.development' \\) -print",
	]);
	assert.equal(
		envFiles,
		'',
		`${name} runtime filesystem에 env 파일이 포함되어 있습니다: ${envFiles}`,
	);
};

const removeContainers = async () => {
	for (const name of Object.values(containerNames).reverse()) {
		await run('docker', ['rm', '--force', name], { stdio: 'ignore' }).catch(
			() => undefined,
		);
	}
};

let failed = false;
try {
	for (const [name, image] of Object.entries(images)) {
		await assertRuntimeImage(name, image);
	}
	await startInfrastructure(infrastructure);
	await migrateDatabase(infrastructure);

	await startContainer({
		name: 'storage',
		image: images.storage,
		port: 3032,
		environment: {
			PORT: '3032',
			CACHE_SERVER: 'http://cache:3030',
			LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS: '0',
		},
	});
	await startContainer({
		name: 'resize',
		image: images.resize,
		port: 3031,
		environment: { PORT: '3031', STORAGE_SERVER: 'http://storage:3032' },
	});
	await startContainer({
		name: 'cache',
		image: images.cache,
		port: 3030,
		environment: { PORT: '3030', RESIZING_SERVER: 'http://resize:3031' },
	});

	console.log(
		`Docker smoke 통과: storage=${hostPorts.storage}, resize=${hostPorts.resize}, cache=${hostPorts.cache}`,
	);
} catch (error) {
	failed = true;
	console.error(error);
	for (const name of Object.values(containerNames)) {
		const logs = await runCapture('docker', ['logs', '--tail', '200', name], {
			includeStderr: true,
		}).catch(() => '');
		if (logs) {
			console.error(`\n--- ${name} logs ---\n${logs}`);
		}
	}
} finally {
	await removeContainers();
	await stopInfrastructure(infrastructure);
}

if (failed) {
	process.exitCode = 1;
}
