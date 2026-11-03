import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIntent, validateImages, readSource } from '../ci-images.mjs';

const source = {
	repository: 'owner/file-server',
	sha: 'a'.repeat(40),
	runId: '123',
	runAttempt: '2',
};
const intent = { schemaVersion: 2, source, deploy: true };
const images = ['storage', 'resize', 'cache'].map((app) => ({
	app,
	localTag: `file-server/${app}:local`,
	imageId: `sha256:${'b'.repeat(64)}`,
	revision: source.sha,
	platform: 'linux/amd64',
	digest: `ghcr.io/owner/${app}@sha256:${'c'.repeat(64)}`,
}));
const manifest = {
	schemaVersion: 2,
	source,
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
	assert.equal(validateIntent({ ...intent, deploy: false }, source), false);
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
