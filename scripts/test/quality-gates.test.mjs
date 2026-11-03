import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) =>
	readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const deploy = read('.github/workflows/deploy.yml');
const setup = read('.github/actions/setup-workspace/action.yml');
const runtime = read('.github/actions/test-runtime-images/action.yml');
const manifest = JSON.parse(read('package.json'));
// Deliberately bounded structural contracts, not a general YAML parser.
const job = (name, source = workflow) => {
	const match = source.match(
		new RegExp(
			`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`,
			'm',
		),
	);
	assert.ok(match, `missing job: ${name}`);
	return match[1];
};

test('quality runs current TypeScript and all script/unit/component gates, not another build', () => {
	assert.equal(manifest.scripts['all:typecheck'], 'node scripts/typecheck.mjs');
	assert.equal(
		manifest.scripts['test:scripts'],
		'node --test scripts/test/*.test.mjs',
	);
	for (const cmd of [
		'all:lint',
		'all:typecheck',
		'test:scripts',
		'all:test',
		'test:component:e2e',
	])
		assert.ok(job('quality').includes('run: pnpm ' + cmd));
	assert.doesNotMatch(job('quality'), /pnpm all:build/);
	assert.doesNotMatch(workflow, /typecheck:ts7|typecheck-ts7/);
	assert.match(
		read('scripts/typecheck.mjs'),
		/require\.resolve\('typescript\/bin\/tsc'\)/,
	);
});

test('host build runs once and both suites reuse this run apps AND libraries with fresh Prisma', () => {
	assert.equal(workflow.split('run: pnpm all:build').length - 1, 1);
	const build = job('build');
	assert.match(build, /needs: changes/);
	assert.match(
		build,
		/apps\/storage\/dist apps\/resize\/dist apps\/cache\/dist apps\/telemetry-api\/dist libs\/\*\/dist/,
	);
	assert.match(build, /compression-level: 0/);
	for (const [name, flag] of [
		['system-e2e', 'SYSTEM_E2E_SKIP_BUILD'],
		['image-lifecycle-e2e', 'IMAGE_LIFECYCLE_E2E_SKIP_BUILD'],
	]) {
		const section = job(name);
		assert.match(section, /needs: \[changes, build\]/);
		assert.match(section, /uses: \.\/\.github\/actions\/setup-workspace/);
		assert.ok(section.includes(flag + ": '1'"));
		assert.match(section, /name: backend-dist-\$\{\{ github\.run_id \}\}/);
		assert.match(section, /tar -xzf/);
	}
	assert.match(setup, /run: pnpm db:generate/);
	assert.doesNotMatch(workflow, /actions\/cache|\.turbo/);
});

test('every selected infra gate has bounded run-specific cancellation cleanup', () => {
	for (const name of [
		'system-e2e',
		'image-lifecycle-e2e',
		'kafka-acl-e2e',
		'docker-smoke',
		'docker-release',
	]) {
		const section = job(name);
		assert.match(section, /timeout-minutes: (?:[1-5]?\d|60)\b/);
		assert.match(section, /github\.run_id/);
		assert.match(section, /github\.run_attempt/);
		assert.match(
			name.startsWith('docker-') ? runtime : section,
			/if: always\(\)/,
		);
		assert.match(
			name.startsWith('docker-') ? runtime : section,
			/run: node scripts\/ci-cleanup\.mjs (?:system|acl)/,
		);
		assert.doesNotMatch(
			section,
			/needs: quality|docker (?:system|volume|network) prune/,
		);
	}
	assert.doesNotMatch(job('kafka-acl-e2e'), /setup-workspace|pnpm |setup-node/);
});

test('path selection always emits one required result, with no pending workflow-level path skips', () => {
	assert.doesNotMatch(workflow, /\bpaths(?:-ignore)?:/);
	assert.match(job('result'), /if: always\(\)/);
	assert.match(job('result'), /failure\*\|\*cancelled/);
	for (const gate of [
		'changes',
		'quality',
		'build',
		'system-e2e',
		'image-lifecycle-e2e',
		'kafka-acl-e2e',
		'docker-smoke',
		'docker-release',
	])
		assert.ok(job('result').includes(gate));
	assert.match(job('result'), /ci-images\.mjs intent/);
	assert.ok(job('result').includes('docker-release'));
	assert.match(job('result'), /needs\.docker-release\.result == 'success'/);
});

test('Docker caches are per app and only trusted main publishes tested candidates', () => {
	const section = runtime;
	for (const app of ['storage', 'resize', 'cache']) {
		assert.ok(section.includes('cache-from: type=gha,scope=' + app));
		assert.ok(section.includes('cache-to: type=gha,mode=max,scope=' + app));
		assert.ok(section.includes('tags: file-server/' + app + ':local'));
	}
	assert.equal(section.split('load: true').length - 1, 3);
	assert.match(section, /platforms: linux\/amd64/);
	assert.ok(
		section.indexOf('run: pnpm test:docker:smoke') <
			section.indexOf('ci-images.mjs publish-candidates'),
	);
	assert.match(section, /if: inputs.publish-candidates == 'true'/);
	assert.match(
		job('docker-release'),
		/github.event_name == 'push' && github.ref == 'refs\/heads\/main'/,
	);
	assert.match(section, /retention-days: 2/);
});

test('privileged publication is source-bound, exact-run/attempt, current main and never rebuilds', () => {
	const section = job('release', deploy);
	for (const predicate of [
		"conclusion == 'success'",
		"event == 'push'",
		"head_branch == 'main'",
		'head_repository.full_name == github.repository',
	])
		assert.ok(section.includes(predicate));
	assert.match(section, /ref: main/);
	assert.match(section, /test "\$GITHUB_SHA" = "\$RELEASE_SHA"/);
	assert.match(section, /test "\$\(git rev-parse HEAD\)" = "\$RELEASE_SHA"/);
	assert.match(section, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
	assert.match(
		section,
		/name: published-images-\$\{\{ github\.event\.workflow_run\.id \}\}/,
	);
	assert.match(section, /ci-images\.mjs check-intent/);
	assert.match(section, /ci-images\.mjs verify-release/);
	assert.doesNotMatch(
		deploy,
		/build-push-action|docker(?: build|:build)|pnpm install|:latest/,
	);
});

test('deployment has pull-only permission, one rollback-aware dependency-ordered entry point', () => {
	const section = job('deploy', deploy);
	assert.match(section, /packages: read/);
	assert.doesNotMatch(section, /packages: write/);
	assert.doesNotMatch(deploy, /packages: write/);
	assert.equal(workflow.split('packages: write').length - 1, 1);
	assert.match(
		job('docker-release'),
		/github.event_name == 'push' && github.ref == 'refs\/heads\/main'/,
	);
	assert.doesNotMatch(job('docker-smoke'), /packages: write|registry-token/);
	assert.match(section, /test "\$\(git rev-parse HEAD\)" = "\$RELEASE_SHA"/);
	assert.match(section, /bash scripts\/deploy-image-services\.sh/);
	const script = read('scripts/deploy-image-services.sh');
	assert.match(script, /storage resize cache/);
	assert.match(script, /127\.0\.0\.1/);
	assert.match(script, /health\/ready/);
	assert.match(script, /verify-deployment-schema\.cjs/);
	assert.match(deploy, /cancel-in-progress: false/);
	assert.match(workflow, /cancel-in-progress: true/);
});

test('all external actions including composite setup are full-SHA pinned', () => {
	for (const source of [workflow, deploy, setup, runtime]) {
		for (const [, action] of source.matchAll(/- uses: (\S+)/g)) {
			if (action.startsWith('./')) continue;
			assert.match(action, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/, action);
		}
	}
});

test('source edits do not invalidate the locked dependency install layer', () => {
	for (const app of ['storage', 'resize', 'cache', 'telemetry-api']) {
		const dockerfile = read(`docker/apps/Dockerfile.${app}`);
		const install = dockerfile.indexOf('pnpm install --frozen-lockfile');
		assert.ok(dockerfile.indexOf(`COPY apps/${app}/package.json`) < install);
		for (const lib of [
			'common-nest',
			'database',
			'global',
			'image-contracts',
			'nest-common',
			'telemetry-contracts',
			'tsconfig',
		]) {
			assert.ok(dockerfile.indexOf(`COPY libs/${lib}/package.json`) < install);
		}
		assert.ok(dockerfile.indexOf(`COPY apps/${app} ./apps/${app}`) > install);
		assert.ok(dockerfile.indexOf('COPY libs ./libs') > install);
		assert.ok(dockerfile.indexOf('COPY prisma ./prisma') > install);
	}
});

test('the three database-only unit skips run against the existing system E2E PostgreSQL', () => {
	const harness = read('scripts/system-e2e.mjs');
	assert.match(harness, /stage3-admin\.postgres\.spec\.ts/);
	assert.match(harness, /database-retention\.postgres\.spec\.ts/);
	assert.match(harness, /STAGE3_POSTGRES_TEST: 'true'/);
	assert.match(harness, /RETENTION_POSTGRES_TEST: 'true'/);
});
