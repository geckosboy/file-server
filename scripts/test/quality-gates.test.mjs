import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) =>
	readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const manifest = JSON.parse(read('package.json'));

// Structural regression checks for our workflow, not a general YAML parser.
const job = (name) => {
	const match = workflow.match(
		new RegExp(
			`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`,
			'm',
		),
	);
	assert.ok(match, `missing CI job: ${name}`);
	return match[1];
};

test('quality uses local TypeScript and runs script regression tests', () => {
	assert.equal(manifest.scripts['all:typecheck'], 'node scripts/typecheck.mjs');
	assert.equal(
		manifest.scripts['test:scripts'],
		'node --test scripts/test/*.test.mjs',
	);
	assert.match(job('quality'), /run: pnpm all:typecheck/);
	assert.match(job('quality'), /run: pnpm test:scripts/);
	assert.doesNotMatch(workflow, /run:.*(?:typecheck:ts7|typecheck-ts7)/);
	const runner = read('scripts/typecheck.mjs');
	assert.match(runner, /require\.resolve\('typescript\/bin\/tsc'\)/);
	assert.match(runner, /'next', 'typegen'/);
	assert.doesNotMatch(runner, /\bdlx\b|typecheck-ts7|TYPESCRIPT_7_VERSION/);
});

test('lifecycle and ACL gates run after quality with bounded isolated cleanup', () => {
	for (const [name, command, project] of [
		[
			'image-lifecycle-e2e',
			'test:image-lifecycle:system:e2e',
			'SYSTEM_E2E_COMPOSE_PROJECT',
		],
		['kafka-acl-e2e', 'test:kafka:acl:e2e', 'KAFKA_ACL_E2E_PROJECT'],
	]) {
		const section = job(name);
		assert.match(section, /needs: quality/);
		assert.match(section, /timeout-minutes: (?:[1-5]?\d|60)\b/);
		assert.ok(section.includes(`run: pnpm ${command}`));
		assert.ok(section.includes(`${project}: fs-`));
		assert.match(section, /github\.run_id/);
		assert.match(section, /github\.run_attempt/);
		assert.match(section, /if: always\(\)/);
		assert.ok(
			section.includes(`-p "$${project}" down --volumes --remove-orphans`),
		);
		assert.doesNotMatch(
			section,
			/docker (?:system|volume|network) prune|secrets\./,
		);
	}
});

test('deployment replaces upstreams before dependent image services', () => {
	const deploy = read('.github/workflows/deploy.yml');
	const resize = deploy
		.split('  deploy-resize:')[1]
		?.split('  deploy-cache:')[0];
	const cache = deploy.split('  deploy-cache:')[1];
	assert.ok(resize && cache);
	assert.match(resize, /needs: \[publish, deploy-storage\]/);
	assert.match(cache, /needs: \[publish, deploy-resize\]/);
});
