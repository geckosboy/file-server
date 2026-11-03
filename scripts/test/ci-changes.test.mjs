import assert from 'node:assert/strict';
import test from 'node:test';
import {
	classifyChanges,
	classifyMainChanges,
	findDeployedBase,
	findVerifiedBase,
} from '../ci-changes.mjs';

const deployed = 'a'.repeat(40);
const baselineEnv = {
	GITHUB_REPOSITORY: 'owner/file-server',
	CI_GIT_TOKEN: 'synthetic',
};
const run = (id, sha) => ({
	id,
	head_sha: sha,
	head_branch: 'main',
	event: 'workflow_run',
	conclusion: 'success',
	head_repository: { full_name: baselineEnv.GITHUB_REPOSITORY },
});
const reply = (data) => ({ ok: true, json: async () => data });

test('superseded pushes retain unverified tests and uncompleted releases without repeating verified admin work', () => {
	const docs = ['docs/architecture.html'];
	const runtime = ['apps/storage/src/change.ts', ...docs];
	assert.deepEqual(classifyMainChanges(runtime, runtime), {
		quality: true,
		build: true,
		backend: true,
		docker: true,
		acl: true,
		adminDocker: false,
	});
	assert.deepEqual(classifyMainChanges(docs, runtime), {
		quality: false,
		build: false,
		backend: false,
		docker: true,
		acl: false,
		adminDocker: false,
	});
	assert.deepEqual(
		classifyMainChanges(docs, ['apps/admin-web/app/page.tsx', ...docs]),
		{
			quality: false,
			build: false,
			backend: false,
			docker: false,
			acl: false,
			adminDocker: true,
		},
	);
	assert.deepEqual(classifyMainChanges(docs, docs), {
		quality: false,
		build: false,
		backend: false,
		docker: false,
		acl: false,
		adminDocker: false,
	});
	assert.deepEqual(classifyMainChanges(docs, undefined), {
		quality: false,
		build: false,
		backend: false,
		docker: true,
		acl: false,
		adminDocker: true,
	});
});
test('verified CI and actual deployment are separate baselines', async () => {
	const verified = 'd'.repeat(40);
	assert.equal(
		await findVerifiedBase(baselineEnv, async () =>
			reply({ workflow_runs: [{ ...run(3, verified), event: 'push' }] }),
		),
		verified,
	);
	assert.equal(
		await findVerifiedBase(baselineEnv, async () =>
			reply({
				workflow_runs: [{ ...run(3, verified), event: 'pull_request' }],
			}),
		),
		undefined,
	);
	// Previously verified admin/docs changes need no more test/build work.
	assert.equal(classifyChanges(['docs/architecture.html']).quality, false);
	// A successful CI without deployment does not cover pending runtime delivery.
	assert.equal(classifyChanges(['apps/storage/src/change.ts']).docker, true);
});
test('runtime push A followed by docs push B compares against deployed P, not cancelled A', async () => {
	const calls = [];
	const request = async (url) => {
		calls.push(url);
		if (url.includes('/workflows/'))
			return reply({
				workflow_runs: [run(2, 'b'.repeat(40)), run(1, deployed)],
			});
		return reply({
			jobs: [
				{
					name: 'Deploy selected services with rollback',
					conclusion: url.includes('/2/') ? 'skipped' : 'success',
				},
			],
		});
	};
	assert.equal(
		await findDeployedBase(
			{ ...baselineEnv, CI_BASE_SHA: 'c'.repeat(40) },
			request,
		),
		deployed,
	);
	assert.equal(
		classifyChanges(['apps/storage/src/change.ts', 'docs/architecture.html'])
			.docker,
		true,
	);
	assert.equal(calls.length, 3);
});
test('missing deployment, API denial, and untrusted source never authorize incremental main skips', async () => {
	assert.equal(
		await findDeployedBase(baselineEnv, async () => ({ ok: false })),
		undefined,
	);
	assert.equal(
		await findDeployedBase(baselineEnv, async (url) =>
			reply(
				url.includes('/workflows/')
					? { workflow_runs: [run(1, deployed)] }
					: {
							jobs: [
								{
									name: 'Deploy selected services with rollback',
									conclusion: 'skipped',
								},
							],
						},
			),
		),
		undefined,
	);
	assert.equal(
		await findDeployedBase(baselineEnv, async () =>
			reply({
				workflow_runs: [
					{
						...run(1, deployed),
						head_repository: { full_name: 'fork/file-server' },
					},
				],
			}),
		),
		undefined,
	);
});

test('docs and measurement changes do not start build or infrastructure', () => {
	assert.deepEqual(
		classifyChanges(['docs/architecture.html', 'artifacts/test.json']),
		{
			quality: false,
			build: false,
			backend: false,
			docker: false,
			acl: false,
			adminDocker: false,
		},
	);
});
test('admin UI selects only admin images, not runtime image infrastructure', () => {
	assert.deepEqual(classifyChanges(['apps/admin-web/app/page.tsx']), {
		quality: true,
		build: true,
		backend: false,
		docker: false,
		acl: false,
		adminDocker: true,
	});
});
test('runtime and shared/schema changes preserve all backend gates', () => {
	for (const file of [
		'apps/storage/src/x.ts',
		'libs/database/src/x.ts',
		'prisma/schema.prisma',
		'pnpm-lock.yaml',
		'.github/workflows/ci.yml',
	]) {
		assert.deepEqual(
			classifyChanges([file]),
			{
				quality: true,
				build: true,
				backend: true,
				docker: true,
				acl: true,
				adminDocker: file !== 'apps/storage/src/x.ts',
			},
			file,
		);
	}
});
test('telemetry-only changes do not rebuild unrelated runtime images', () => {
	assert.deepEqual(classifyChanges(['apps/telemetry-api/src/x.ts']), {
		quality: true,
		build: true,
		backend: true,
		docker: false,
		acl: true,
		adminDocker: true,
	});
});
test('fault harness and docker changes trigger their own real gates', () => {
	assert.equal(
		classifyChanges(['scripts/image-asset-backfill.mjs']).backend,
		true,
	);
	assert.equal(
		classifyChanges(['scripts/image-lifecycle-system-e2e.mjs']).backend,
		true,
	);
	assert.equal(classifyChanges(['scripts/system-test-utils.mjs']).docker, true);
	assert.equal(
		classifyChanges(['docker/docker-compose.system-e2e.yml']).backend,
		true,
	);
	assert.equal(
		classifyChanges(['scripts/kafka/test/kafka-acl-isolation.e2e.sh']).acl,
		true,
	);
});
test('manual or missing-base run fails safe to full verification', () => {
	assert.deepEqual(classifyChanges([], true), {
		quality: true,
		build: true,
		backend: true,
		docker: true,
		acl: true,
		adminDocker: true,
	});
});

test('deployment script edits only run quality; schema preflight edits exercise Docker but no unrelated host build', () => {
	assert.deepEqual(classifyChanges(['scripts/deploy-image-services.sh']), {
		quality: true,
		build: false,
		backend: false,
		docker: false,
		acl: false,
		adminDocker: false,
	});
	assert.deepEqual(classifyChanges(['scripts/verify-deployment-schema.cjs']), {
		quality: true,
		build: false,
		backend: false,
		docker: true,
		acl: false,
		adminDocker: true,
	});
});

test('shared image smoke and boundary harness changes select both groups', () => {
	for (const file of [
		'scripts/image-groups-smoke.mjs',
		'scripts/deployment-boundary-e2e.mjs',
	]) {
		const flags = classifyChanges([file]);
		assert.equal(flags.docker, true, file);
		assert.equal(flags.adminDocker, true, file);
	}
	const pending = classifyMainChanges(
		['docs/architecture.html'],
		['apps/admin-web/src/page.tsx', 'apps/storage/src/x.ts'],
	);
	assert.equal(pending.quality, false);
	assert.equal(pending.docker, true);
	assert.equal(pending.adminDocker, true);
});

test('admin proxy changes exercise only the admin image group', () => {
	for (const file of [
		'docker/nginx/admin.conf.example',
		'scripts/admin-proxy-smoke.mjs',
	]) {
		const flags = classifyChanges([file]);
		assert.equal(flags.adminDocker, true);
		assert.equal(flags.docker, false);
	}
});
