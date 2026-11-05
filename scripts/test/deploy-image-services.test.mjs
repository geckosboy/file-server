import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const deployScript = path.join(
	repositoryRoot,
	'scripts/deploy-image-services.sh',
);
const schemaScript = path.join(
	repositoryRoot,
	'scripts/verify-deployment-schema.cjs',
);
const imageDigest = `ghcr.io/example/service@sha256:${'a'.repeat(64)}`;
const fixtureRoots = new Set();

after(async () => {
	await Promise.all(
		[...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })),
	);
});

const runtimeServices = ['storage', 'resize', 'cache'];
const adminServices = ['telemetry-api', 'admin-web'];

async function fixture({
	oldContainers = true,
	services = runtimeServices,
} = {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'deploy-image-services-'));
	fixtureRoots.add(root);
	const bin = path.join(root, 'bin');
	const statePath = path.join(root, 'state.json');
	const logPath = path.join(root, 'commands.log');
	await import('node:fs/promises').then(({ mkdir }) => mkdir(bin));
	const containers = {};
	if (oldContainers) {
		for (const service of services) {
			containers[`file_server_${service}`] = { running: true };
		}
	}
	await writeFile(statePath, JSON.stringify({ containers }));
	await writeFile(logPath, '');

	const fakeDocker = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.FAKE_DOCKER_STATE;
const logPath = process.env.FAKE_COMMAND_LOG;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => {
  const temporary = statePath + '.' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, statePath);
};
const delayAfterMutation = () => {
  if (process.env.FAKE_DELAY_COMMAND && args.join(' ').includes(process.env.FAKE_DELAY_COMMAND)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DELAY_MS || 1500));
  }
};
fs.appendFileSync(logPath, 'docker ' + args.join(' ') + '\\n');
const fail = (message) => { if (message) process.stderr.write(message + '\\n'); process.exit(1); };
if (args[0] === 'network' && args[1] === 'inspect') process.exit(process.env.FAKE_MISSING_NETWORK === args[2] ? 1 : 0);
if (args[0] === 'volume' && args[1] === 'inspect') process.exit(process.env.FAKE_MISSING_VOLUME ? 1 : 0);
if (args[0] === 'pull') process.exit(0);
if (args[0] === 'image' && args[1] === 'inspect') { console.log(process.env.FAKE_PLATFORM || 'linux/amd64'); process.exit(0); }
if (args[0] === 'run') process.exit(process.env.FAKE_SCHEMA_FAILURE ? 1 : 0);
if (args[0] === 'inspect') {
  const name = args.at(-1);
  const item = state.containers[name];
  if (!item) fail();
  if (args.includes('--format')) console.log(item.running ? 'true' : 'false');
  process.exit(0);
}
if (args[0] === 'create') {
  const name = args[args.indexOf('--name') + 1];
  if (!name || state.containers[name]) fail('create collision');
  state.containers[name] = { running: false };
  save();
  delayAfterMutation();
  console.log('fake-id');
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'connect') process.exit(0);
if (args[0] === 'stop') {
  const item = state.containers[args.at(-1)]; if (!item) fail(); item.running = false; save(); delayAfterMutation(); process.exit(0);
}
if (args[0] === 'rename') {
  const item = state.containers[args[1]]; if (!item || state.containers[args[2]]) fail();
  delete state.containers[args[1]]; state.containers[args[2]] = item; save(); delayAfterMutation(); process.exit(0);
}
if (args[0] === 'start') {
  const item = state.containers[args.at(-1)]; if (!item) fail(); item.running = true; save(); process.exit(0);
}
if (args[0] === 'rm') {
  const name = args.at(-1); if (!state.containers[name]) fail();
  if (process.env.FAKE_RM_FAILURE && name.includes(process.env.FAKE_RM_FAILURE)) fail('forced rm failure');
  delete state.containers[name]; save(); process.exit(0);
}
fail('unsupported docker command: ' + args.join(' '));
`;
	const fakeCurl = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.at(-1);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, 'curl ' + args.join(' ') + '\\n');
if (process.env.FAKE_CURL_SLEEP) {
  setTimeout(() => process.exit(1), Number(process.env.FAKE_CURL_SLEEP) * 1000);
} else {
  process.exit(process.env.FAKE_CURL_FAILURE && url.includes(process.env.FAKE_CURL_FAILURE) ? 1 : 0);
}
`;
	await writeFile(path.join(bin, 'docker'), fakeDocker);
	await writeFile(path.join(bin, 'curl'), fakeCurl);
	await chmod(path.join(bin, 'docker'), 0o755);
	await chmod(path.join(bin, 'curl'), 0o755);

	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		FAKE_DOCKER_STATE: statePath,
		FAKE_COMMAND_LOG: logPath,
		STORAGE_IMAGE: imageDigest,
		RESIZE_IMAGE: imageDigest.replace('/service', '/resize'),
		CACHE_IMAGE: imageDigest.replace('/service', '/cache'),
		TELEMETRY_API_IMAGE: imageDigest.replace('/service', '/telemetry-api'),
		ADMIN_WEB_IMAGE: imageDigest.replace('/service', '/admin-web'),
		STORAGE_ENV_PATH: path.join(root, 'storage.env'),
		RESIZE_ENV_PATH: path.join(root, 'resize.env'),
		CACHE_ENV_PATH: path.join(root, 'cache.env'),
		TELEMETRY_API_ENV_PATH: path.join(root, 'telemetry-api.env'),
		ADMIN_WEB_ENV_PATH: path.join(root, 'admin-web.env'),
		STORAGE_PORT: '3032',
		RESIZE_PORT: '3031',
		CACHE_PORT: '3030',
		TELEMETRY_API_PORT: '3100',
		ADMIN_WEB_PORT: '3000',
		FILE_SERVER_NET: 'file-net',
		KAFKA_NET: 'kafka-net',
		FILE_DUMP_VOLUME: 'file_dump_volume',
		DEPLOY_RUN_ID: '123-456',
		DEPLOY_READY_TIMEOUT_SECONDS: '20',
	};
	for (const name of ['storage', 'resize', 'cache']) {
		await writeFile(
			path.join(root, `${name}.env`),
			'DATABASE_URL=postgresql://hidden\n',
		);
	}
	await writeFile(
		path.join(root, 'telemetry-api.env'),
		'DATABASE_URL=postgresql://hidden\nTELEMETRY_ADMIN_TOKEN=admin-token\n',
	);
	await writeFile(
		path.join(root, 'admin-web.env'),
		'TELEMETRY_API_BASE_URL=http://file_server_telemetry-api:3100/api/admin\nTELEMETRY_ADMIN_TOKEN=admin-token\nADMIN_WEB_PROXY_SECRET=proxy-secret\n',
	);
	return { root, statePath, logPath, env };
}

async function installDeterministicClock(testFixture, startSeconds = 1_000) {
	const clockStatePath = path.join(testFixture.root, 'clock-state');
	const datePath = path.join(testFixture.root, 'bin', 'date');
	await writeFile(clockStatePath, String(startSeconds));
	await writeFile(
		datePath,
		`#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.FAKE_CLOCK_STATE;
const current = Number(fs.readFileSync(statePath, 'utf8'));
fs.writeFileSync(statePath, String(current + 1));
process.stdout.write(String(current) + '\\n');
`,
	);
	await chmod(datePath, 0o755);
	testFixture.env.FAKE_CLOCK_STATE = clockStatePath;
}

function runDeploy(env) {
	return new Promise((resolve) => {
		const child = spawn('bash', [deployScript], { env });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('close', (code, signal) =>
			resolve({ code, signal, stdout, stderr }),
		);
	});
}

async function waitUntil(predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error('condition was not reached before timeout');
}

test('deploy image services safety', { concurrency: 4 }, async (context) => {
	const cases = [];
	const deployTest = (name, implementation) =>
		cases.push(context.test(name, implementation));

	deployTest(
		'invalid input fails before any docker mutation or inspection',
		async () => {
			const testFixture = await fixture();
			testFixture.env.CACHE_PORT = 'not-a-port';
			const result = await runDeploy(testFixture.env);
			assert.notEqual(result.code, 0);
			assert.equal(await readFile(testFixture.logPath, 'utf8'), '');
		},
	);

	deployTest(
		'invalid or duplicate deployment groups fail before Docker access',
		async () => {
			for (const groups of [
				'',
				'admin,',
				'runtime,runtime',
				'admin,runtime',
				'runtime,unknown',
			]) {
				const testFixture = await fixture();
				testFixture.env.DEPLOY_GROUPS = groups;
				const result = await runDeploy(testFixture.env);
				assert.notEqual(result.code, 0);
				assert.equal(await readFile(testFixture.logPath, 'utf8'), '');
			}
		},
	);

	deployTest(
		'admin-only deployment requires no runtime image or storage volume and keeps the API private',
		async () => {
			const testFixture = await fixture({ services: adminServices });
			testFixture.env.DEPLOY_GROUPS = 'admin';
			for (const name of [
				'STORAGE_IMAGE',
				'RESIZE_IMAGE',
				'CACHE_IMAGE',
				'STORAGE_ENV_PATH',
				'RESIZE_ENV_PATH',
				'CACHE_ENV_PATH',
				'STORAGE_PORT',
				'RESIZE_PORT',
				'CACHE_PORT',
				'FILE_DUMP_VOLUME',
			]) {
				delete testFixture.env[name];
			}

			const result = await runDeploy(testFixture.env);
			assert.equal(result.code, 0, result.stderr);
			const state = JSON.parse(await readFile(testFixture.statePath, 'utf8'));
			assert.deepEqual(Object.keys(state.containers).sort(), [
				'file_server_admin-web',
				'file_server_telemetry-api',
			]);
			const log = await readFile(testFixture.logPath, 'utf8');
			assert.doesNotMatch(
				log,
				/docker volume inspect|file_server_(storage|resize|cache)/,
			);
			assert.match(
				log,
				/docker create .*--publish 127\.0\.0\.1:3100:3100 --name file_server_telemetry-api_candidate_123-456/,
			);
			assert.match(
				log,
				/telemetry-api\/verify-deployment-schema\.cjs:ro .* node \/usr\/index\/apps\/telemetry-api\/verify-deployment-schema\.cjs/,
			);
			assert.match(
				log,
				/docker create .*--name file_server_admin-web_candidate_123-456 .*--env HOSTNAME=0\.0\.0\.0/,
			);
			assert.match(
				log,
				/docker network connect kafka-net file_server_telemetry-api_candidate_123-456/,
			);
			assert.doesNotMatch(
				log,
				/docker network connect kafka-net file_server_admin-web_candidate_123-456/,
			);
		},
	);

	deployTest(
		'admin secret mismatch fails before Docker access without leaking either value',
		async () => {
			const testFixture = await fixture({ services: adminServices });
			testFixture.env.DEPLOY_GROUPS = 'admin';
			await writeFile(
				testFixture.env.ADMIN_WEB_ENV_PATH,
				'TELEMETRY_API_BASE_URL=http://file_server_telemetry-api:3100/api/admin\nTELEMETRY_ADMIN_TOKEN=different-admin-token\nADMIN_WEB_PROXY_SECRET=private-proxy-secret\n',
			);
			const result = await runDeploy(testFixture.env);
			assert.notEqual(result.code, 0);
			assert.match(result.stderr, /TELEMETRY_ADMIN_TOKEN values must match/);
			assert.doesNotMatch(result.stderr, /admin-token|private-proxy-secret/);
			assert.equal(await readFile(testFixture.logPath, 'utf8'), '');
		},
	);

	deployTest(
		'admin token comparison uses the exact Docker env-file values',
		async () => {
			for (const token of ["'admin-token'", ' admin-token']) {
				const testFixture = await fixture({ services: adminServices });
				testFixture.env.DEPLOY_GROUPS = 'admin';
				await writeFile(
					testFixture.env.ADMIN_WEB_ENV_PATH,
					`TELEMETRY_API_BASE_URL=http://file_server_telemetry-api:3100/api/admin\nTELEMETRY_ADMIN_TOKEN=${token}\nADMIN_WEB_PROXY_SECRET=proxy-secret\n`,
				);
				const result = await runDeploy(testFixture.env);
				assert.notEqual(result.code, 0);
				assert.match(result.stderr, /TELEMETRY_ADMIN_TOKEN values must match/);
				assert.doesNotMatch(result.stderr, /admin-token|proxy-secret/);
				assert.equal(await readFile(testFixture.logPath, 'utf8'), '');
			}
		},
	);

	deployTest(
		'admin API must use the private container address and no public override',
		async () => {
			const invalidAdminEnvironments = [
				'TELEMETRY_API_BASE_URL=https://admin-api.example.com/api/admin\nTELEMETRY_ADMIN_TOKEN=admin-token\nADMIN_WEB_PROXY_SECRET=proxy-secret\n',
				'TELEMETRY_API_BASE_URL=http://file_server_telemetry-api:3100/api/admin\nNEXT_PUBLIC_TELEMETRY_API_BASE_URL=https://public.example.com/api/admin\nTELEMETRY_ADMIN_TOKEN=admin-token\nADMIN_WEB_PROXY_SECRET=proxy-secret\n',
				'TELEMETRY_API_BASE_URL=http://file_server_telemetry-api:3100/api/admin\nNEXT_PUBLIC_TELEMETRY_API_BASE_URL\nTELEMETRY_ADMIN_TOKEN=admin-token\nADMIN_WEB_PROXY_SECRET=proxy-secret\n',
			];
			for (const environment of invalidAdminEnvironments) {
				const testFixture = await fixture({ services: adminServices });
				testFixture.env.DEPLOY_GROUPS = 'admin';
				await writeFile(testFixture.env.ADMIN_WEB_ENV_PATH, environment);
				const result = await runDeploy(testFixture.env);
				assert.notEqual(result.code, 0);
				assert.equal(await readFile(testFixture.logPath, 'utf8'), '');
				assert.doesNotMatch(result.stderr, /admin-token|proxy-secret/);
			}
		},
	);

	deployTest(
		'admin proxy secret over 128 bytes fails before Docker access',
		async () => {
			const testFixture = await fixture({ services: adminServices });
			testFixture.env.DEPLOY_GROUPS = 'admin';
			const oversizedSecret = 'p'.repeat(129);
			await writeFile(
				testFixture.env.ADMIN_WEB_ENV_PATH,
				`TELEMETRY_API_BASE_URL=http://file_server_telemetry-api:3100/api/admin\nTELEMETRY_ADMIN_TOKEN=admin-token\nADMIN_WEB_PROXY_SECRET=${oversizedSecret}\n`,
			);
			const result = await runDeploy(testFixture.env);
			assert.notEqual(result.code, 0);
			assert.match(result.stderr, /between 1 and 128 bytes/);
			assert.doesNotMatch(result.stderr, /admin-token/);
			assert.ok(!result.stderr.includes(oversizedSecret));
			assert.equal(await readFile(testFixture.logPath, 'utf8'), '');
		},
	);

	deployTest(
		'combined deployment requires one exact shared database URL',
		async () => {
			const testFixture = await fixture({
				services: [...runtimeServices, ...adminServices],
			});
			testFixture.env.DEPLOY_GROUPS = 'runtime,admin';
			await writeFile(
				testFixture.env.RESIZE_ENV_PATH,
				'DATABASE_URL=postgresql://different-hidden\n',
			);
			const result = await runDeploy(testFixture.env);
			assert.notEqual(result.code, 0);
			assert.match(result.stderr, /same DATABASE_URL/);
			assert.doesNotMatch(result.stderr, /postgresql:/);
			assert.equal(await readFile(testFixture.logPath, 'utf8'), '');
		},
	);

	deployTest(
		'schema preflight failure does not create, stop, or rename containers',
		async () => {
			const testFixture = await fixture();
			testFixture.env.FAKE_SCHEMA_FAILURE = '1';
			const result = await runDeploy(testFixture.env);
			assert.notEqual(result.code, 0);
			const log = await readFile(testFixture.logPath, 'utf8');
			assert.match(log, /docker run --rm/);
			assert.doesNotMatch(log, /docker (create|stop|rename|start|rm) /);
		},
	);

	deployTest(
		'prepares every stopped candidate and both networks before replacing upstream-first',
		async () => {
			const testFixture = await fixture();
			const result = await runDeploy(testFixture.env);
			assert.equal(result.code, 0, result.stderr);
			const log = await readFile(testFixture.logPath, 'utf8');
			const firstStop = log.indexOf('docker stop file_server_storage');
			for (const service of ['storage', 'resize', 'cache']) {
				const candidate = `file_server_${service}_candidate_123-456`;
				assert.ok(log.indexOf(`--name ${candidate}`) < firstStop);
				assert.ok(
					log.indexOf(`docker network connect kafka-net ${candidate}`) <
						firstStop,
				);
			}
			assert.ok(firstStop < log.indexOf('docker stop file_server_resize'));
			assert.ok(
				log.indexOf('docker stop file_server_resize') <
					log.indexOf('docker stop file_server_cache'),
			);
			assert.match(
				log,
				/curl --fail --silent --show-error --connect-timeout 1 --max-time [123] http:\/\/127\.0\.0\.1:3032\/health\/ready/,
			);
			assert.ok(
				log.indexOf('docker run --rm') < firstStop,
				'schema verification precedes replacement',
			);
		},
	);

	deployTest(
		'downstream readiness timeout rolls back all replaced services',
		async () => {
			const testFixture = await fixture();
			await installDeterministicClock(testFixture);
			testFixture.env.DEPLOY_READY_TIMEOUT_SECONDS = '4';
			testFixture.env.FAKE_CURL_FAILURE = ':3030/';
			const result = await runDeploy(testFixture.env);
			assert.notEqual(result.code, 0);
			const state = JSON.parse(await readFile(testFixture.statePath, 'utf8'));
			assert.deepEqual(Object.keys(state.containers).sort(), [
				'file_server_cache',
				'file_server_resize',
				'file_server_storage',
			]);
			assert.ok(
				Object.values(state.containers).every(({ running }) => running),
			);
			const log = await readFile(testFixture.logPath, 'utf8');
			assert.ok(
				log.indexOf(
					'docker rename file_server_storage_backup_123-456 file_server_storage',
				) > log.indexOf('http://127.0.0.1:3030/health/ready'),
			);
		},
	);

	deployTest(
		'combined deployment rolls back all five services when admin-web readiness fails',
		async () => {
			const services = [...runtimeServices, ...adminServices];
			const testFixture = await fixture({ services });
			testFixture.env.DEPLOY_GROUPS = 'runtime,admin';
			await installDeterministicClock(testFixture);
			testFixture.env.DEPLOY_READY_TIMEOUT_SECONDS = '7';
			testFixture.env.FAKE_CURL_FAILURE = ':3000/';
			const result = await runDeploy(testFixture.env);
			assert.notEqual(result.code, 0);
			const state = JSON.parse(await readFile(testFixture.statePath, 'utf8'));
			assert.deepEqual(
				Object.keys(state.containers).sort(),
				services.map((service) => `file_server_${service}`).sort(),
			);
			assert.ok(
				Object.values(state.containers).every(({ running }) => running),
			);
			const log = await readFile(testFixture.logPath, 'utf8');
			for (const service of services) {
				assert.ok(
					log.indexOf(
						`docker rename file_server_${service}_backup_123-456 file_server_${service}`,
					) > log.indexOf('http://127.0.0.1:3000/health/ready'),
				);
			}
		},
	);

	deployTest(
		'successful deployment removes only stopped run-scoped backups',
		async () => {
			const testFixture = await fixture();
			const result = await runDeploy(testFixture.env);
			assert.equal(result.code, 0, result.stderr);
			const state = JSON.parse(await readFile(testFixture.statePath, 'utf8'));
			assert.deepEqual(Object.keys(state.containers).sort(), [
				'file_server_cache',
				'file_server_resize',
				'file_server_storage',
			]);
			assert.ok(
				Object.values(state.containers).every(({ running }) => running),
			);
			const log = await readFile(testFixture.logPath, 'utf8');
			for (const service of ['storage', 'resize', 'cache']) {
				assert.match(
					log,
					new RegExp(`docker rm file_server_${service}_backup_123-456`),
				);
			}
			assert.doesNotMatch(
				log,
				/prune|docker rm -f file_server_(?!storage_backup|resize_backup|cache_backup)/,
			);
		},
	);

	deployTest(
		'backup garbage-collection failure never rolls back healthy new services',
		async () => {
			const testFixture = await fixture();
			testFixture.env.FAKE_RM_FAILURE = 'resize_backup';
			const result = await runDeploy(testFixture.env);
			assert.notEqual(result.code, 0);
			assert.match(result.stderr, /deployment is healthy and remains active/);
			const state = JSON.parse(await readFile(testFixture.statePath, 'utf8'));
			assert.deepEqual(Object.keys(state.containers).sort(), [
				'file_server_cache',
				'file_server_resize',
				'file_server_resize_backup_123-456',
				'file_server_storage',
			]);
			assert.ok(
				[
					'file_server_storage',
					'file_server_resize',
					'file_server_cache',
				].every((name) => state.containers[name].running),
			);
			const log = await readFile(testFixture.logPath, 'utf8');
			assert.doesNotMatch(
				log,
				/docker rename file_server_storage_backup_123-456 file_server_storage/,
			);
		},
	);

	deployTest(
		'first deployment succeeds without old containers but still uses the existing volume',
		async () => {
			const testFixture = await fixture({ oldContainers: false });
			const result = await runDeploy(testFixture.env);
			assert.equal(result.code, 0, result.stderr);
			const state = JSON.parse(await readFile(testFixture.statePath, 'utf8'));
			assert.deepEqual(Object.keys(state.containers).sort(), [
				'file_server_cache',
				'file_server_resize',
				'file_server_storage',
			]);
			const log = await readFile(testFixture.logPath, 'utf8');
			assert.match(log, /docker volume inspect file_dump_volume/);
			assert.doesNotMatch(
				log,
				/docker (rename|rm) file_server_(storage|resize|cache)_backup_123-456/,
			);
		},
	);

	deployTest(
		'SIGTERM during docker stop restores the prior service using pre-intent state',
		async () => {
			const testFixture = await fixture();
			testFixture.env.FAKE_DELAY_COMMAND = 'stop file_server_storage';
			testFixture.env.FAKE_DELAY_MS = '1200';
			const child = spawn('bash', [deployScript], { env: testFixture.env });
			const closed = new Promise((resolve) => child.on('close', resolve));
			await waitUntil(async () => {
				const state = JSON.parse(await readFile(testFixture.statePath, 'utf8'));
				return state.containers.file_server_storage?.running === false;
			});
			child.kill('SIGTERM');
			await closed;
			const state = JSON.parse(await readFile(testFixture.statePath, 'utf8'));
			assert.deepEqual(Object.keys(state.containers).sort(), [
				'file_server_cache',
				'file_server_resize',
				'file_server_storage',
			]);
			assert.ok(
				Object.values(state.containers).every(({ running }) => running),
			);
		},
	);

	deployTest(
		'schema result validation rejects incomplete migrations and invalid indexes',
		() => {
			const { validateDeploymentState } = require(schemaScript);
			const expected = [
				'000001_init',
				'000011_add_image_asset_backfill_indexes',
			];
			assert.deepEqual(
				validateDeploymentState(
					[
						{
							migration_name: expected[0],
							finished_at: new Date(),
							rolled_back_at: null,
						},
						{
							migration_name: expected[1],
							finished_at: new Date(),
							rolled_back_at: null,
						},
					],
					[
						{
							index_name: 'telemetry_events_image_asset_backfill_idx',
							is_valid: true,
							is_ready: true,
						},
						{
							index_name: 'image_lifecycle_events_image_asset_backfill_idx',
							is_valid: true,
							is_ready: true,
						},
					],
					expected,
				),
				[],
			);
			assert.deepEqual(
				validateDeploymentState(
					[
						{
							migration_name: expected[0],
							finished_at: null,
							rolled_back_at: new Date(),
						},
						{
							migration_name: expected[0],
							finished_at: new Date(),
							rolled_back_at: null,
						},
						{
							migration_name: expected[1],
							finished_at: new Date(),
							rolled_back_at: null,
						},
					],
					[
						{
							index_name: 'telemetry_events_image_asset_backfill_idx',
							is_valid: true,
							is_ready: true,
						},
						{
							index_name: 'image_lifecycle_events_image_asset_backfill_idx',
							is_valid: true,
							is_ready: true,
						},
					],
					expected,
				),
				[],
				'a rolled-back historical attempt is ignored after a successful retry',
			);
			assert.match(
				validateDeploymentState([], [], expected).join('\n'),
				/000001_init.*not applied|not applied.*000001_init/,
			);
			assert.match(
				validateDeploymentState(
					expected.map((migration_name) => ({
						migration_name,
						finished_at: new Date(),
						rolled_back_at: null,
					})),
					[
						{
							index_name: 'telemetry_events_image_asset_backfill_idx',
							is_valid: false,
							is_ready: true,
						},
						{
							index_name: 'image_lifecycle_events_image_asset_backfill_idx',
							is_valid: true,
							is_ready: true,
						},
					],
					expected,
				).join('\n'),
				/telemetry_events_image_asset_backfill_idx.*valid and ready/,
			);
			const verifierSource = readFileSync(schemaScript, 'utf8');
			assert.match(
				verifierSource,
				/createRequire\(require\.resolve\('@file\/database'\)\)/,
			);
			assert.match(verifierSource, /connectionTimeoutMillis:\s*5_000/);
			assert.match(verifierSource, /statement_timeout:\s*5_000/);
		},
	);

	await Promise.all(cases);
});
