import assert from 'node:assert/strict';
import {
	access,
	chmod,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const script = path.join(
	repositoryRoot,
	'scripts/kafka/test/kafka-acl-isolation.e2e.sh',
);
const fixtureRoots = new Set();

after(async () => {
	await Promise.all(
		[...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture({ startupFailure = false, downFailure = false } = {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'kafka-acl-startup-'));
	fixtureRoots.add(root);
	const dockerPath = path.join(root, 'docker');
	const logPath = path.join(root, 'docker.log');
	const configPath = path.join(root, 'config-path');
	await writeFile(logPath, '');
	await writeFile(
		dockerPath,
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = (...parts) => fs.appendFileSync(process.env.FAKE_DOCKER_LOG, parts.join(' ') + '\\n');
log(...args);
if (args[0] === 'compose' && args.includes('up')) {
  const dir = process.env.KAFKA_ACL_E2E_CONFIG_DIR;
  fs.writeFileSync(process.env.FAKE_CONFIG_PATH, dir);
  const dirMode = fs.statSync(dir).mode & 0o777;
  const files = fs.readdirSync(dir).sort();
  log('config-mode', dirMode.toString(8), 'file-modes', files.map((file) => (fs.statSync(dir + '/' + file).mode & 0o777).toString(8)).join(','));
  if (process.env.FAKE_STARTUP_FAILURE === '1') process.exit(17);
}
if (args[0] === 'compose' && args.includes('down') && process.env.FAKE_DOWN_FAILURE === '1') process.exit(42);
if (args[0] === 'compose' && args.includes('ps') && args.includes('--quiet') && args.includes('kafka')) {
  console.log('fake-kafka-container');
  process.exit(0);
}
if (args[0] === 'inspect' && args.includes('{{json .State.Health}}')) {
  console.log('{"Status":"unhealthy","Log":[{"ExitCode":1,"Output":"health-probe-failed"}]}');
  process.exit(0);
}
if (args[0] === 'inspect') {
  console.log('KAFKA_NODE_ID=1');
  console.log('KAFKA_LISTENER_NAME_INTERNAL_PLAIN_SASL_JAAS_CONFIG=must-not-leak');
  process.exit(0);
}
if (args[0] === 'compose' && args.includes('logs')) {
  console.error('broker-startup-log');
  process.exit(0);
}
if (args[0] === 'compose' && args.includes('exec')) {
  const joined = args.join(' ');
  if (joined.includes(' id;') || joined.includes("'id;")) console.error('uid=1000(appuser) gid=1000(appuser)');
  if (joined.includes('kafka-console-consumer.sh')) {
    if (joined.includes('storage.properties')) console.log('{"eventId":"image-lifecycle-storage-variant"}');
    else if (joined.includes('cache.properties') && joined.includes('file.image.cache-invalidation.v1')) console.log('{"eventId":"image-lifecycle-storage-invalidation"}');
    else if (joined.includes('client-a.properties') && joined.includes('file.image.lifecycle.client.client-a.v1')) console.log('{"topic":"file.image.lifecycle.client.client-a.v1"}');
    else { console.error('TopicAuthorizationException: not authorized'); process.exit(1); }
  }
  if (joined.includes('kafka-console-producer.sh') && (joined.includes('client-a.properties') || (joined.includes('cache.properties') && joined.includes('file.image.cache-invalidation.v1')))) {
    console.error('TopicAuthorizationException: not authorized');
    process.exit(1);
  }
}
process.exit(0);
`,
	);
	await chmod(dockerPath, 0o755);
	return {
		root,
		logPath,
		configPath,
		env: {
			...process.env,
			PATH: `${root}:${process.env.PATH}`,
			FAKE_DOCKER_LOG: logPath,
			FAKE_CONFIG_PATH: configPath,
			FAKE_STARTUP_FAILURE: startupFailure ? '1' : '0',
			FAKE_DOWN_FAILURE: downFailure ? '1' : '0',
			KAFKA_ACL_E2E_PROJECT: 'fs-kafka-acl-test-123',
		},
	};
}

function runScript(env) {
	return new Promise((resolve) => {
		const child = spawn('bash', [script], { env });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('close', (code) => resolve({ code, stdout, stderr }));
	});
}

test('Kafka ACL startup boundary', { concurrency: 2 }, async (context) => {
	await context.test(
		'makes synthetic client configs readable before startup and preserves failed-health evidence',
		async () => {
			const testFixture = await fixture({ startupFailure: true });
			const result = await runScript(testFixture.env);
			assert.equal(result.code, 17);
			const dockerLog = await readFile(testFixture.logPath, 'utf8');
			assert.match(dockerLog, /config-mode 755 file-modes (?:644,){4}644/);
			assert.match(result.stderr, /Docker health log/);
			assert.match(result.stderr, /health-probe-failed/);
			assert.match(result.stderr, /broker-startup-log/);
			assert.match(result.stderr, /uid=1000\(appuser\)/);
			assert.match(result.stderr, /KAFKA_NODE_ID=1/);
			assert.match(
				result.stderr,
				/KAFKA_LISTENER_NAME_INTERNAL_PLAIN_SASL_JAAS_CONFIG=<redacted>/,
			);
			assert.doesNotMatch(result.stderr, /must-not-leak/);
			assert.match(
				dockerLog,
				/compose .* -p fs-kafka-acl-test-123 down --volumes --remove-orphans/,
			);
			const removedConfigDir = await readFile(testFixture.configPath, 'utf8');
			await assert.rejects(access(removedConfigDir, constants.F_OK));
		},
	);

	await context.test(
		'does not swallow exact-project compose cleanup failures',
		async () => {
			const testFixture = await fixture({ downFailure: true });
			const result = await runScript(testFixture.env);
			assert.notEqual(result.code, 0);
			assert.match(
				result.stderr,
				/Kafka ACL E2E cleanup failed for compose project: fs-kafka-acl-test-123/,
			);
			const dockerLog = await readFile(testFixture.logPath, 'utf8');
			assert.equal(
				dockerLog.match(/ down --volumes --remove-orphans/g)?.length,
				1,
			);
			assert.doesNotMatch(dockerLog, /prune/);
		},
	);
});
