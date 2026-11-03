import assert from 'node:assert/strict';
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, runCapture } from './system-test-utils.mjs';

export const imageGroups = {
	runtime: ['storage', 'resize', 'cache'],
	admin: ['telemetry-api', 'admin-web'],
};
export const validateGroups = (groups, allowEmpty = false) => {
	assert.ok(Array.isArray(groups), 'selectedGroups must be an array');
	assert.ok(allowEmpty || groups.length > 0, 'no image group selected');
	assert.deepEqual(
		groups,
		Object.keys(imageGroups).filter((group) => groups.includes(group)),
		'unknown, duplicate or non-canonical image groups',
	);
	return groups;
};
export const parseGroups = (value, allowEmpty = false) =>
	validateGroups(value ? value.split(',') : [], allowEmpty);
export const appsForGroups = (groups) =>
	validateGroups(groups).flatMap((group) => imageGroups[group]);
export const groupsForFlags = (runtime, admin) => {
	for (const flag of [runtime, admin])
		assert.ok(['true', 'false'].includes(flag));
	return [runtime === 'true' && 'runtime', admin === 'true' && 'admin'].filter(
		Boolean,
	);
};
const imageId = /^sha256:[a-f0-9]{64}$/;
export const readSource = (env = process.env) => {
	const source = {
		repository: env.GITHUB_REPOSITORY,
		sha: env.RELEASE_SHA ?? env.GITHUB_SHA,
		runId: env.SOURCE_RUN_ID ?? env.GITHUB_RUN_ID,
		runAttempt: env.SOURCE_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT,
	};
	assert.match(source.repository ?? '', /^[\w.-]+\/[\w.-]+$/);
	assert.match(source.sha ?? '', /^[a-f0-9]{40}$/);
	assert.match(source.runId ?? '', /^[1-9]\d*$/);
	assert.match(source.runAttempt ?? '', /^[1-9]\d*$/);
	return source;
};
const validateSource = (data, source, earlierProducer = false) => {
	assert.equal(data?.schemaVersion, 3);
	const actual = { ...data.source };
	if (earlierProducer) {
		assert.match(actual.runAttempt ?? '', /^[1-9]\d*$/);
		assert.ok(
			Number(actual.runAttempt) <= Number(source.runAttempt),
			'artifact source producer attempt is newer than successful CI',
		);
		actual.runAttempt = source.runAttempt;
	}
	assert.deepEqual(
		actual,
		source,
		'artifact source does not match trusted run',
	);
};
export const validateIntent = (data, source) => {
	validateSource(data, source);
	assert.equal(typeof data.deploy, 'boolean');
	validateGroups(data.selectedGroups, !data.deploy);
	assert.equal(data.deploy, data.selectedGroups.length > 0);
	return data.deploy;
};
const validateIdentities = (images, source, groups) => {
	assert.deepEqual(
		images.map((i) => i.app).sort(),
		appsForGroups(groups).sort(),
	);
	for (const image of images) {
		assert.equal(image.localTag, `file-server/${image.app}:local`);
		assert.match(image.imageId, imageId);
		assert.equal(image.revision, source.sha);
		assert.equal(image.platform, 'linux/amd64');
	}
};
const repositoryFor = (app, source, registry) =>
	`${registry}/${source.repository.split('/')[0].toLowerCase()}/${app}`;
export const validateImages = (
	data,
	source,
	registry = 'ghcr.io',
	expectedGroups = ['runtime'],
) => {
	validateSource(data, source, true);
	validateGroups(data.selectedGroups);
	assert.deepEqual(
		data.selectedGroups,
		validateGroups(expectedGroups),
		'image selection does not match release intent',
	);
	validateIdentities(data.images, source, expectedGroups);
	for (const image of data.images) {
		const prefix = repositoryFor(image.app, source, registry) + '@';
		assert.ok(
			image.digest?.startsWith(prefix),
			'unexpected registry or application repository',
		);
		assert.match(image.digest.slice(prefix.length), imageId);
	}
	return data.images;
};
const output = (key, value) => {
	if (process.env.GITHUB_OUTPUT)
		appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
	console.log(`${key}=${value}`);
};
const inspect = async (tags) =>
	JSON.parse(await runCapture('docker', ['image', 'inspect', ...tags]));
const assertLoaded = (actual, expected) => {
	assert.equal(
		actual.Id,
		expected.imageId,
		'published image differs from smoke-tested image',
	);
	assert.equal(
		actual.Config.Labels?.['org.opencontainers.image.revision'],
		expected.revision,
	);
	assert.equal(`${actual.Os}/${actual.Architecture}`, expected.platform);
};

// Called only by the main-push, packages-write job AFTER smoke succeeds.
// The loopback injection supports an isolated real-registry test, not a CLI flag.
export const publishCandidates = async (
	directory,
	source = readSource(),
	registry = 'ghcr.io',
	groups = ['runtime'],
) => {
	assert.ok(registry === 'ghcr.io' || /^127\.0\.0\.1:\d+$/.test(registry));
	const apps = appsForGroups(groups);
	const tags = apps.map((app) => `file-server/${app}:local`);
	const actual = await inspect(tags);
	const images = apps.map((app, i) => ({
		app,
		localTag: tags[i],
		imageId: actual[i].Id,
		revision: actual[i].Config.Labels?.['org.opencontainers.image.revision'],
		platform: `${actual[i].Os}/${actual[i].Architecture}`,
	}));
	validateIdentities(images, source, groups); // Validate every selected image before publication.
	await Promise.all(
		images.map(async (image) => {
			const repository = repositoryFor(image.app, source, registry);
			const tag = `${repository}:ci-${source.runId}-${source.runAttempt}`;
			await run('docker', ['tag', image.imageId, tag]);
			await run('docker', ['push', tag]);
			const [published] = await inspect([tag]);
			assertLoaded(published, image);
			image.digest = published.RepoDigests?.find((ref) =>
				ref.startsWith(`${repository}@`),
			);
			assert.ok(image.digest, 'registry digest missing after candidate push');
		}),
	);
	const manifest = { schemaVersion: 3, source, selectedGroups: groups, images };
	validateImages(manifest, source, registry, groups);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		resolve(directory, 'images.json'),
		JSON.stringify(manifest, null, 2) + '\n',
	);
	return manifest;
};
export const verifyRelease = (
	path,
	source = readSource(),
	groups = ['runtime'],
) => {
	const images = validateImages(
		JSON.parse(readFileSync(path, 'utf8')),
		source,
		'ghcr.io',
		groups,
	);
	for (const image of images)
		output(`${image.app.replaceAll('-', '_')}_image`, image.digest);
	return images;
};

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const [command, path, arg, runtime, admin] = process.argv.slice(2);
	const source = readSource();
	if (command === 'intent') {
		assert.ok(['true', 'false'].includes(arg));
		const selectedGroups = groupsForFlags(runtime, admin);
		const intent = {
			schemaVersion: 3,
			source,
			deploy: arg === 'true',
			selectedGroups,
		};
		validateIntent(intent, source);
		writeFileSync(path, JSON.stringify(intent) + '\n');
	} else if (command === 'check-intent') {
		const intent = JSON.parse(readFileSync(path, 'utf8'));
		output('deploy', validateIntent(intent, source));
		output('groups', intent.selectedGroups.join(','));
	} else if (command === 'publish-candidates')
		await publishCandidates(path, source, 'ghcr.io', parseGroups(arg));
	else if (command === 'verify-release')
		verifyRelease(path, source, parseGroups(arg));
	else
		throw new Error(
			'Expected intent, check-intent, publish-candidates or verify-release',
		);
}
