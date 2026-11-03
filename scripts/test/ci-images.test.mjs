import assert from 'node:assert/strict';
import test from 'node:test';
import {
	validateIntent,
	validateImages,
	readSource,
	appsForGroups,
	parseGroups,
	groupsForFlags,
} from '../ci-images.mjs';

const source = {
	repository: 'owner/file-server',
	sha: 'a'.repeat(40),
	runId: '123',
	runAttempt: '2',
};
const intent = {
	schemaVersion: 3,
	source,
	deploy: true,
	selectedGroups: ['runtime'],
};
const images = ['storage', 'resize', 'cache'].map((app) => ({
	app,
	localTag: `file-server/${app}:local`,
	imageId: `sha256:${'b'.repeat(64)}`,
	revision: source.sha,
	platform: 'linux/amd64',
	digest: `ghcr.io/owner/${app}@sha256:${'c'.repeat(64)}`,
}));
const manifest = {
	schemaVersion: 3,
	source,
	selectedGroups: ['runtime'],
	images,
};

test('only the exact source run, attempt, repository and commit can publish', () => {
	assert.equal(validateIntent(intent, source), true);
	for (const [key, value] of [
		['repository', 'fork/file-server'],
		['sha', 'd'.repeat(40)],
		['runId', '124'],
		['runAttempt', '1'],
	]) {
		assert.throws(
			() => validateIntent(intent, { ...source, [key]: value }),
			/source/,
		);
		assert.throws(
			() => validateImages(manifest, { ...source, [key]: value }),
			/source/,
		);
	}
});
test('non-deployable successful changes are explicit, not inferred from missing manifests', () => {
	assert.equal(
		validateIntent({ ...intent, deploy: false, selectedGroups: [] }, source),
		false,
	);
	assert.throws(() => validateIntent({ ...intent, deploy: 'false' }, source));
	assert.throws(() => validateIntent(undefined, source));
});

test('failed-only reruns reuse an earlier successful producer from the same immutable run', () => {
	assert.equal(
		validateImages(manifest, { ...source, runAttempt: '3' }).length,
		3,
	);
	assert.throws(
		() => validateIntent(intent, { ...source, runAttempt: '3' }),
		/source/,
	);
	assert.throws(
		() => validateImages(manifest, { ...source, runAttempt: '1' }),
		/source/,
	);
});
test('image manifest requires all and only three tested amd64 identities', () => {
	assert.equal(validateImages(manifest, source).length, 3);
	for (const bad of [
		images.slice(1),
		[...images, images[0]],
		images.map((i, n) => (n ? i : { ...i, imageId: 'latest' })),
		images.map((i, n) => (n ? i : { ...i, revision: 'f'.repeat(40) })),
		images.map((i, n) => (n ? i : { ...i, platform: 'linux/arm64' })),
		images.map((i, n) => (n ? i : { ...i, localTag: 'untrusted:tag' })),
	]) {
		assert.throws(() => validateImages({ ...manifest, images: bad }, source));
	}
});
test('source data and digests must be complete bounded identifiers', () => {
	assert.deepEqual(
		readSource({
			GITHUB_REPOSITORY: source.repository,
			RELEASE_SHA: source.sha,
			SOURCE_RUN_ID: source.runId,
			SOURCE_RUN_ATTEMPT: source.runAttempt,
		}),
		source,
	);
	assert.throws(() => readSource({}));
	assert.throws(() =>
		validateImages(
			{
				...manifest,
				images: images.map((i) => ({ ...i, digest: 'untrusted:tag' })),
			},
			source,
		),
	);
});

const groupManifest = (groups) => ({
	...manifest,
	selectedGroups: groups,
	images: appsForGroups(groups).map((app) => ({
		...images[0],
		app,
		localTag: `file-server/${app}:local`,
		digest: `ghcr.io/owner/${app}@sha256:${'c'.repeat(64)}`,
	})),
});

test('admin and combined releases require exact intent-bound image sets', () => {
	for (const groups of [['admin'], ['runtime', 'admin']]) {
		const data = groupManifest(groups);
		assert.equal(
			validateImages(data, source, 'ghcr.io', groups).length,
			groups.length === 1 ? 2 : 5,
		);
		assert.throws(() => validateImages(data, source));
		assert.throws(() =>
			validateImages(
				{ ...data, images: data.images.slice(1) },
				source,
				'ghcr.io',
				groups,
			),
		);
		assert.throws(() =>
			validateImages(
				{ ...data, images: [...data.images, data.images[0]] },
				source,
				'ghcr.io',
				groups,
			),
		);
	}
	assert.throws(() =>
		validateImages(
			{ ...groupManifest(['admin']), selectedGroups: ['runtime'] },
			source,
		),
	);
	assert.throws(() =>
		validateImages({ ...manifest, schemaVersion: 2 }, source),
	);
	assert.throws(() => validateIntent({ ...intent, deploy: false }, source));
	assert.throws(() =>
		validateIntent({ ...intent, selectedGroups: [] }, source),
	);
});
test('group inputs reject unknown, duplicate, reordered and empty selections', () => {
	assert.deepEqual(parseGroups('runtime,admin'), ['runtime', 'admin']);
	assert.deepEqual(groupsForFlags('false', 'true'), ['admin']);
	for (const value of [
		'',
		'other',
		'runtime,runtime',
		'admin,runtime',
		'runtime,',
	])
		assert.throws(() => parseGroups(value));
	assert.throws(() => groupsForFlags('true', 'yes'));
	assert.throws(() =>
		validateIntent(
			{ ...intent, selectedGroups: ['runtime', 'runtime'] },
			source,
		),
	);
});

test('CLI binds admin intent and normalized image outputs without runtime images', async () => {
	const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { execFileSync } = await import('node:child_process');
	const root = await mkdtemp(join(tmpdir(), 'admin-release-cli-'));
	const env = {
		...process.env,
		GITHUB_REPOSITORY: source.repository,
		GITHUB_SHA: source.sha,
		GITHUB_RUN_ID: source.runId,
		GITHUB_RUN_ATTEMPT: source.runAttempt,
	};
	delete env.GITHUB_OUTPUT;
	delete env.RELEASE_SHA;
	delete env.SOURCE_RUN_ID;
	delete env.SOURCE_RUN_ATTEMPT;
	const cli = (args) =>
		execFileSync(process.execPath, ['scripts/ci-images.mjs', ...args], {
			env,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	try {
		const intentPath = join(root, 'intent.json');
		cli(['intent', intentPath, 'true', 'false', 'true']);
		assert.deepEqual(
			JSON.parse(await readFile(intentPath, 'utf8')).selectedGroups,
			['admin'],
		);
		assert.match(cli(['check-intent', intentPath]), /groups=admin\n/);
		const imagePath = join(root, 'images.json');
		await writeFile(imagePath, JSON.stringify(groupManifest(['admin'])));
		const output = cli(['verify-release', imagePath, 'admin']);
		assert.match(
			output,
			/telemetry_api_image=ghcr.io\/owner\/telemetry-api@sha256:/,
		);
		assert.match(output, /admin_web_image=ghcr.io\/owner\/admin-web@sha256:/);
		assert.doesNotMatch(output, /storage_image=/);
		assert.throws(() => cli(['verify-release', imagePath, 'runtime']));
		assert.throws(() => cli(['intent', intentPath, 'false', 'false', 'true']));
		cli(['intent', intentPath, 'false', 'false', 'false']);
		assert.equal(JSON.parse(await readFile(intentPath, 'utf8')).deploy, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
