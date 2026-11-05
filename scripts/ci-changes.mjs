import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const classifyChanges = (files, full = false) => {
	const common =
		full ||
		files.some((path) =>
			/^(?:\.github\/(?:workflows|actions)\/|(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|prisma\.config\.ts|tsconfig(?:\.[\w-]+)?\.json|turbo\.json)$|scripts\/(?:ci-|test\/ci-))/.test(
				path,
			),
		);
	const backend =
		common ||
		files.some((path) =>
			/^(?:apps\/(?:storage|resize|cache|telemetry-api)\/|libs\/|prisma\/|scripts\/(?:system(?:-test-utils|-e2e)|image-asset-backfill|image-lifecycle-system-e2e(?:-helpers)?)\.mjs$|docker\/docker-compose\.system-e2e\.yml$)/.test(
				path,
			),
		);
	const docker =
		common ||
		files.includes('scripts/verify-deployment-schema.cjs') ||
		files.includes('scripts/image-groups-smoke.mjs') ||
		files.some((path) =>
			/^(?:apps\/(?:storage|resize|cache)\/|libs\/|prisma\/|docker\/apps\/Dockerfile\.(?:storage|resize|cache)$|docker\/docker-compose\.system-e2e\.yml$|\.dockerignore$|scripts\/(?:docker-smoke|deployment-boundary-e2e|system-test-utils)\.mjs$)/.test(
				path,
			),
		);
	const acl =
		backend ||
		common ||
		files.some((path) =>
			/^(?:scripts\/kafka\/|docker\/kafka\/|docker\/docker-compose\.kafka-acl-e2e\.yml$)/.test(
				path,
			),
		);
	const adminDocker =
		common ||
		files.includes('scripts/verify-deployment-schema.cjs') ||
		files.includes('scripts/deployment-boundary-e2e.mjs') ||
		files.some((path) => path.startsWith('docker/nginx/')) ||
		files.includes('scripts/admin-proxy-smoke.mjs') ||
		files.some((path) =>
			/^(?:apps\/(?:admin-web|telemetry-api)\/|libs\/|prisma\/|docker\/apps\/Dockerfile\.(?:admin-web|telemetry-api)$|docker\/docker-compose\.system-e2e\.yml$|\.dockerignore$|scripts\/(?:admin-docker-smoke|image-groups-smoke|system-test-utils)\.mjs$)/.test(
				path,
			),
		);
	const quality =
		common ||
		backend ||
		docker ||
		acl ||
		files.some((path) => !/^(?:docs\/|artifacts\/|.*\.md$)/.test(path));
	const build =
		common || backend || files.some((path) => /^(?:apps|libs)\//.test(path));
	return { quality, build, backend, docker, acl, adminDocker };
};

export const classifyMainChanges = (
	verifiedFiles,
	deployedFiles,
	full = false,
) => {
	const flags = classifyChanges(verifiedFiles, full);
	flags.docker ||= !deployedFiles || classifyChanges(deployedFiles).docker;
	flags.adminDocker ||=
		!deployedFiles || classifyChanges(deployedFiles).adminDocker;
	return flags;
};

// A docs push can cancel a runtime push: event.before is not a verified baseline.
// Only an actual successful deployment covers superseded main-branch changes.
export const findVerifiedBase = async (env, request = fetch) => {
	if (
		!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ||
		!env.CI_GIT_TOKEN
	)
		return undefined;
	try {
		const response = await request(
			`${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=30`,
			{
				headers: {
					authorization: `Bearer ${env.CI_GIT_TOKEN}`,
					accept: 'application/vnd.github+json',
				},
				signal: AbortSignal.timeout(8_000),
			},
		);
		if (!response.ok) throw new Error('CI baseline unavailable');
		const { workflow_runs: runs } = await response.json();
		const baseline = runs.find(
			(run) =>
				run.event === 'push' &&
				run.conclusion === 'success' &&
				run.head_branch === 'main' &&
				run.head_repository?.full_name === env.GITHUB_REPOSITORY &&
				/^[a-f0-9]{40}$/.test(run.head_sha),
		)?.head_sha;
		if (!baseline)
			console.warn(
				'No successful CI baseline; running all verification gates.',
			);
		return baseline;
	} catch {
		console.warn(
			'Verified CI baseline unavailable; running full verification (API/network/response).',
		);
		return undefined;
	}
};

export const findDeployedBase = async (env, request = fetch) => {
	const repository = env.GITHUB_REPOSITORY;
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !env.CI_GIT_TOKEN)
		return undefined;
	const signal = AbortSignal.timeout(8_000);
	const get = async (path) => {
		const response = await request(
			`${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}/${path}`,
			{
				headers: {
					authorization: `Bearer ${env.CI_GIT_TOKEN}`,
					accept: 'application/vnd.github+json',
				},
				signal,
			},
		);
		if (!response.ok) throw new Error('Deployment baseline unavailable');
		return response.json();
	};
	try {
		const { workflow_runs: runs } = await get(
			'actions/workflows/deploy.yml/runs?branch=main&status=success&per_page=30',
		);
		const candidates = runs.filter(
			(run) =>
				run.event === 'workflow_run' &&
				run.conclusion === 'success' &&
				run.head_branch === 'main' &&
				run.head_repository?.full_name === repository &&
				/^[a-f0-9]{40}$/.test(run.head_sha),
		);
		for (let offset = 0; offset < candidates.length; offset += 5) {
			const batch = await Promise.all(
				candidates.slice(offset, offset + 5).map(async (run) => {
					const { jobs } = await get(
						`actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
					);
					return jobs.some(
						(job) =>
							job.name === 'Deploy selected services with rollback' &&
							job.conclusion === 'success',
					)
						? run.head_sha
						: undefined;
				}),
			);
			const baseline = batch.find(Boolean);
			if (baseline) return baseline;
		}
	} catch (error) {
		const reason = ['TimeoutError', 'AbortError'].includes(error?.name)
			? 'lookup deadline exceeded'
			: 'API access, network or response unavailable';
		console.warn(
			`Deployment baseline unavailable; forcing release-image gates: ${reason}`,
		);
		return undefined;
	}
	console.warn(
		'No successful actual deployment in the lookup window; forcing release-image gates.',
	);
	return undefined;
};

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const mainPush =
		process.env.GITHUB_EVENT_NAME === 'push' &&
		process.env.GITHUB_REF === 'refs/heads/main';
	const [base, deployedBase] = mainPush
		? await Promise.all([
				findVerifiedBase(process.env),
				findDeployedBase(process.env),
			])
		: [process.env.CI_BASE_SHA, undefined];
	let full =
		process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ||
		Number(process.env.GITHUB_RUN_ATTEMPT) > 1 ||
		!/^[a-f0-9]{40}$/.test(base ?? '') ||
		/^0+$/.test(base);
	let files = [];
	const readDiff = (baseSha) => {
		const env = { ...process.env };
		if (env.CI_GIT_TOKEN) {
			env.GIT_CONFIG_COUNT = '1';
			env.GIT_CONFIG_KEY_0 = `http.${env.GITHUB_SERVER_URL ?? 'https://github.com'}/.extraheader`;
			env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.CI_GIT_TOKEN}`).toString('base64')}`;
		}
		execFileSync(
			'git',
			['fetch', '--no-tags', '--depth=1', 'origin', baseSha],
			{
				stdio: 'pipe',
				env,
			},
		);
		return execFileSync('git', ['diff', '--name-only', '-z', baseSha, 'HEAD'], {
			encoding: 'utf8',
		})
			.split('\0')
			.filter(Boolean);
	};
	let deployedFiles;
	if (!full) {
		try {
			files = readDiff(base);
			// CI success covers tests, not deployment. Pending/superseded releases
			// still need current-head images even when the code already passed CI.
			if (mainPush && deployedBase)
				deployedFiles = deployedBase === base ? files : readDiff(deployedBase);
		} catch {
			console.warn(
				'Base unavailable; running full verification instead of skipping gates.',
			);
			full = true;
		}
	}
	const flags = mainPush
		? classifyMainChanges(files, deployedFiles, full)
		: classifyChanges(files, full);
	console.log(JSON.stringify({ files: files.length, ...flags }));
	if (process.env.GITHUB_OUTPUT)
		appendFileSync(
			process.env.GITHUB_OUTPUT,
			Object.entries(flags)
				.map(([key, value]) => `${key}=${value}\n`)
				.join(''),
		);
}
