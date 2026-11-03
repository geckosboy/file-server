import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const cleanupScript = path.join(repositoryRoot, 'scripts/ci-cleanup.mjs');
const fixtureRoots = new Set();

after(async () => {
	await Promise.all(
		[...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), 'ci-cleanup-'));
	fixtureRoots.add(root);
	const dockerPath = path.join(root, 'docker');
	const logPath = path.join(root, 'docker.log');
	await writeFile(logPath, '');
	await writeFile(
		dockerPath,
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, args.join(' ') + '\\n');
if (process.env.FAKE_DOWN_FAILURE && args.includes('down')) process.exit(42);
if (process.env.FAKE_REMAINING && args.includes('--filter')) {
  if (args[0] === 'ps') console.log('owned-container');
  if (args[0] === 'network') console.log('owned-network');
  if (args[0] === 'volume') console.log('owned-volume');
}
process.exit(0);
`,
	);
	await chmod(dockerPath, 0o755);
	return {
		logPath,
		env: {
			...process.env,
			PATH: `${root}:${process.env.PATH}`,
			FAKE_DOCKER_LOG: logPath,
			SYSTEM_E2E_COMPOSE_PROJECT: 'fs-system-ci-123-2',
			KAFKA_ACL_E2E_PROJECT: 'fs-acl-ci-123-2',
		},
	};
}

function runCleanup(mode, env) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cleanupScript, mode], { env });
		let stderr = '';
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('close', (code) => resolve({ code, stderr }));
	});
}

test('bounded CI cleanup', { concurrency: 4 }, async (context) => {
	const cases = [];
	const cleanupTest = (name, implementation) =>
		cases.push(context.test(name, implementation));

	cleanupTest('rejects an unsafe project before invoking Docker', async () => {
		const testFixture = await fixture();
		testFixture.env.SYSTEM_E2E_COMPOSE_PROJECT = 'file-server-production';
		const result = await runCleanup('system', testFixture.env);
		assert.notEqual(result.code, 0);
		assert.equal(await readFile(testFixture.logPath, 'utf8'), '');
	});

	cleanupTest(
		'uses exact compose project and only scoped project-label filters',
		async () => {
			const testFixture = await fixture();
			const result = await runCleanup('system', testFixture.env);
			assert.equal(result.code, 0, result.stderr);
			const log = await readFile(testFixture.logPath, 'utf8');
			assert.match(
				log,
				/compose -f .*docker-compose\.system-e2e\.yml -p fs-system-ci-123-2 down --volumes --remove-orphans/,
			);
			for (const resourceCommand of [
				'ps -aq',
				'network ls -q',
				'volume ls -q',
			]) {
				assert.match(
					log,
					new RegExp(
						`${resourceCommand} --filter label=com\\.docker\\.compose\\.project=fs-system-ci-123-2`,
					),
				);
				assert.match(
					log,
					new RegExp(
						`${resourceCommand} --filter label=io\\.file-server\\.test-project=fs-system-ci-123-2`,
					),
				);
			}
			assert.doesNotMatch(
				log,
				/prune|docker system|label=io\.file-server\.test-project\s/,
			);
		},
	);

	cleanupTest('propagates docker compose down failures', async () => {
		const testFixture = await fixture();
		testFixture.env.FAKE_DOWN_FAILURE = '1';
		const result = await runCleanup('acl', testFixture.env);
		assert.notEqual(result.code, 0);
		const log = await readFile(testFixture.logPath, 'utf8');
		assert.match(
			log,
			/compose -f .*docker-compose\.kafka-acl-e2e\.yml -p fs-acl-ci-123-2 down --volumes --remove-orphans/,
		);
	});

	cleanupTest(
		'removes only discovered labelled resources and fails a non-zero verification',
		async () => {
			const testFixture = await fixture();
			testFixture.env.FAKE_REMAINING = '1';
			const result = await runCleanup('system', testFixture.env);
			assert.notEqual(result.code, 0);
			const log = await readFile(testFixture.logPath, 'utf8');
			assert.match(log, /rm --force owned-container/);
			assert.match(log, /network rm owned-network/);
			assert.match(log, /volume rm --force owned-volume/);
			assert.doesNotMatch(log, /prune/);
		},
	);

	cleanupTest(
		'smoke and deployment-boundary resources carry the CI project label',
		async () => {
			const [smoke, boundary] = await Promise.all([
				readFile(path.join(repositoryRoot, 'scripts/docker-smoke.mjs'), 'utf8'),
				readFile(
					path.join(repositoryRoot, 'scripts/deployment-boundary-e2e.mjs'),
					'utf8',
				),
			]);
			assert.match(
				smoke,
				/io\.file-server\.test-project=\$\{infrastructure\.project\}/,
			);
			assert.match(boundary, /SYSTEM_E2E_COMPOSE_PROJECT/);
			assert.match(boundary, /io\.file-server\.test-project=\$\{ciProject\}/);
		},
	);

	await Promise.all(cases);
});
