import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
	createInfrastructureConfig,
	getFreePort,
	migrateDatabase,
	repoRoot,
	run,
	runCapture,
	startInfrastructure,
	stopInfrastructure,
	waitForHttp,
} from './system-test-utils.mjs';
import { runAdminProxySmoke } from './admin-proxy-smoke.mjs';

export async function runAdminDockerSmoke({
	infrastructure: sharedInfrastructure,
	manageInfrastructure = true,
} = {}) {
	const infrastructure =
		sharedInfrastructure ??
		(await createInfrastructureConfig('admin-docker-smoke'));
	const images = {
		telemetryApi:
			process.env.TELEMETRY_API_IMAGE ?? 'file-server/telemetry-api:local',
		adminWeb: process.env.ADMIN_WEB_IMAGE ?? 'file-server/admin-web:local',
	};
	const ports = {
		telemetryApi: Number(
			process.env.ADMIN_DOCKER_SMOKE_TELEMETRY_API_PORT ||
				(await getFreePort()),
		),
		adminWeb: Number(
			process.env.ADMIN_DOCKER_SMOKE_ADMIN_WEB_PORT || (await getFreePort()),
		),
	};
	const names = {
		telemetryApi: `fs-admin-smoke-telemetry-api-${process.pid}`,
		adminWeb: `fs-admin-smoke-admin-web-${process.pid}`,
	};
	const label = `io.file-server.test-project=${infrastructure.project}`;
	const secrets = {
		adminToken: 'admin-smoke-token-not-for-production',
		proxySecret: 'admin-smoke-proxy-secret-not-for-production',
		internalKey: 'admin-smoke-internal-key-not-for-production',
		apiKeyPepper: 'admin-smoke-pepper-not-for-production',
	};

	const envArgs = (environment) =>
		Object.entries(environment).flatMap(([name, value]) => [
			'--env',
			`${name}=${value}`,
		]);

	async function assertRuntimeImage(name, image) {
		const [metadata] = JSON.parse(
			await runCapture('docker', ['image', 'inspect', image]),
		);
		assert.equal(`${metadata.Os}/${metadata.Architecture}`, 'linux/amd64');
		assert.equal(metadata.Config.User, 'node');
		assert.doesNotMatch(
			JSON.stringify(metadata.Config.Env),
			/(DATABASE_URL|TELEMETRY_ADMIN_TOKEN|ADMIN_WEB_PROXY_SECRET|CLIENT_API_KEY_PEPPER|INTERNAL_API_KEY|postgresql:\/\/)/i,
			`${name} image config에 runtime secret이 포함되어 있습니다.`,
		);
	}

	async function startContainer({ key, port, environment }) {
		await run('docker', [
			'run',
			'--detach',
			'--name',
			names[key],
			'--label',
			label,
			'--network',
			infrastructure.network,
			'--network-alias',
			key === 'telemetryApi' ? 'telemetry-api' : 'admin-web',
			'--publish',
			`127.0.0.1:${ports[key]}:${port}`,
			...envArgs(environment),
			images[key],
		]);
	}

	async function assertNoSecretFilesOrBundles(name) {
		const envFiles = await runCapture('docker', [
			'exec',
			name,
			'sh',
			'-c',
			"find /usr/index -type f -name '.env*' -print",
		]);
		assert.equal(envFiles, '', `${name} runtime에 env 파일이 포함됐습니다.`);

		for (const secret of Object.values(secrets)) {
			const matches = await runCapture('docker', [
				'exec',
				'--env',
				`SCAN_SECRET=${secret}`,
				name,
				'sh',
				'-c',
				`find /usr/index \\
				-path '*/node_modules' -prune -o \\
				-type f -size -5M -exec grep -Fl "$SCAN_SECRET" {} + 2>/dev/null || test $? -eq 1`,
			]);
			assert.equal(
				matches,
				'',
				`${name} filesystem에 runtime secret이 있습니다.`,
			);
		}
	}

	async function removeAppContainers() {
		const errors = [];
		for (const name of Object.values(names).reverse()) {
			try {
				await run('docker', ['rm', '--force', name], { stdio: 'ignore' });
			} catch (error) {
				const exists = await runCapture('docker', [
					'ps',
					'-aq',
					'--filter',
					`name=^/${name}$`,
				]);
				if (exists) errors.push(error);
			}
		}
		if (errors.length)
			throw new AggregateError(errors, 'admin app cleanup failed');
	}

	async function assertCleaned() {
		if (manageInfrastructure) {
			for (const type of ['container', 'network', 'volume']) {
				const command =
					type === 'container' ? ['ps', '-aq'] : [type, 'ls', '-q'];
				const remaining = await runCapture('docker', [
					...command,
					'--filter',
					`label=com.docker.compose.project=${infrastructure.project}`,
				]);
				assert.equal(remaining, '', `${type} cleanup이 완료되지 않았습니다.`);
			}
		}
		assert.equal(
			await runCapture('docker', ['ps', '-aq', '--filter', `label=${label}`]),
			'',
			'admin smoke container cleanup이 완료되지 않았습니다.',
		);
	}

	let primaryError;
	try {
		await Promise.all(
			Object.entries(images).map(([name, image]) =>
				assertRuntimeImage(name, image),
			),
		);
		if (manageInfrastructure) {
			await startInfrastructure(infrastructure);
			await migrateDatabase(infrastructure);
		}

		await run('docker', [
			'run',
			'--rm',
			'--network',
			infrastructure.network,
			'--label',
			label,
			'--env',
			'DATABASE_URL=postgresql://file_server:file_server@postgres:5432/file_server',
			'--env',
			`EXPECTED_MIGRATIONS=${readdirSync(`${repoRoot}/prisma/migrations`, {
				withFileTypes: true,
			})
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort()
				.join(',')}`,
			'--volume',
			`${repoRoot}/scripts/verify-deployment-schema.cjs:/usr/index/apps/telemetry-api/verify-deployment-schema.cjs:ro`,
			'--entrypoint',
			'node',
			images.telemetryApi,
			'/usr/index/apps/telemetry-api/verify-deployment-schema.cjs',
		]);

		await startContainer({
			key: 'telemetryApi',
			port: 3100,
			environment: {
				NODE_ENV: 'production',
				HOST: '0.0.0.0',
				PORT: '3100',
				DATABASE_URL:
					'postgresql://file_server:file_server@postgres:5432/file_server',
				KAFKA_CLIENT_BROKERS: 'kafka:9092',
				CLIENT_API_KEY_PEPPER: secrets.apiKeyPepper,
				INTERNAL_API_KEY: secrets.internalKey,
				TELEMETRY_ADMIN_TOKEN: secrets.adminToken,
				TELEMETRY_CORS_ORIGINS: `http://127.0.0.1:${ports.adminWeb}`,
				TELEMETRY_HTTP_INGESTION_ENABLED: 'false',
				TELEMETRY_KAFKA_CONSUMER_ENABLED: 'true',
				TELEMETRY_KAFKA_GROUP_ID: `admin-smoke-telemetry-${process.pid}`,
				TELEMETRY_KAFKA_FROM_BEGINNING: 'false',
				LIFECYCLE_KAFKA_CONSUMER_ENABLED: 'true',
				LIFECYCLE_KAFKA_GROUP_ID: `admin-smoke-lifecycle-${process.pid}`,
				LIFECYCLE_KAFKA_FROM_BEGINNING: 'false',
				LIFECYCLE_TOPIC_PROVISIONING_ENABLED: 'false',
				DATA_RETENTION_ENABLED: 'false',
				DATA_RETENTION_INTERVAL_MS: '0',
				IMAGE_ASSET_DUAL_READ_ENABLED: 'true',
				IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED: 'false',
			},
		});
		await waitForHttp(`http://127.0.0.1:${ports.telemetryApi}/health/ready`, {
			timeoutMs: 60_000,
		});

		const anonymousApi = await fetch(
			`http://127.0.0.1:${ports.telemetryApi}/api/admin/dashboard/summary`,
		);
		assert.equal(anonymousApi.status, 401);
		await anonymousApi.body?.cancel();
		const adminApi = await fetch(
			`http://127.0.0.1:${ports.telemetryApi}/api/admin/dashboard/summary`,
			{ headers: { 'x-admin-token': secrets.adminToken } },
		);
		assert.equal(adminApi.status, 200);
		assert.equal(adminApi.headers.get('content-type')?.includes('json'), true);
		await adminApi.body?.cancel();

		await startContainer({
			key: 'adminWeb',
			port: 3000,
			environment: {
				NODE_ENV: 'production',
				HOSTNAME: '0.0.0.0',
				PORT: '3000',
				TELEMETRY_API_BASE_URL: 'http://telemetry-api:3100/api/admin',
				TELEMETRY_ADMIN_TOKEN: secrets.adminToken,
				ADMIN_WEB_PROXY_SECRET: secrets.proxySecret,
				ADMIN_WEB_AUTH_DISABLED: 'false',
				ADMIN_WEB_ENABLE_FIXTURES: 'false',
			},
		});
		await waitForHttp(`http://127.0.0.1:${ports.adminWeb}/health/live`, {
			timeoutMs: 60_000,
		});
		await waitForHttp(`http://127.0.0.1:${ports.adminWeb}/health/ready`, {
			timeoutMs: 60_000,
		});

		const anonymousPage = await fetch(
			`http://127.0.0.1:${ports.adminWeb}/dashboard`,
		);
		assert.equal(anonymousPage.status, 401);
		await anonymousPage.body?.cancel();
		for (const headers of [
			{ 'x-file-admin-proxy-secret': secrets.proxySecret },
			{
				'x-file-admin-proxy-secret': 'forged-secret',
				'x-file-admin-user': 'forged-admin',
			},
		]) {
			const forged = await fetch(
				`http://127.0.0.1:${ports.adminWeb}/dashboard`,
				{ headers },
			);
			assert.equal(forged.status, 401);
			await forged.body?.cancel();
		}

		const authenticatedHeaders = {
			'x-file-admin-proxy-secret': secrets.proxySecret,
			'x-file-admin-user': 'admin-smoke-operator',
			'x-request-id': 'admin-smoke-request',
		};
		const dashboard = await fetch(
			`http://127.0.0.1:${ports.adminWeb}/dashboard`,
			{ headers: authenticatedHeaders },
		);
		assert.equal(dashboard.status, 200);
		const html = await dashboard.text();
		assert.match(html, /파일서버 관리자 대시보드/);
		assert.doesNotMatch(html, /연결할 수 없습니다|fixture 데이터/);
		for (const secret of Object.values(secrets))
			assert.ok(!html.includes(secret));

		const servicesPage = await fetch(
			`http://127.0.0.1:${ports.adminWeb}/services`,
			{ headers: authenticatedHeaders },
		);
		assert.equal(servicesPage.status, 200);
		const servicesHtml = await servicesPage.text();
		assert.match(servicesHtml, /서비스 레지스트리/);
		assert.doesNotMatch(servicesHtml, /연결할 수 없습니다|fixture 데이터/);

		const staticPath = html.match(
			/(?:src|href)="([^"?]*\/_next\/static\/[^"?]+)"/,
		)?.[1];
		assert.ok(
			staticPath,
			'admin-web HTML에서 static asset 경로를 찾지 못했습니다.',
		);
		const staticResponse = await fetch(
			new URL(staticPath, `http://127.0.0.1:${ports.adminWeb}`),
		);
		assert.equal(staticResponse.status, 200);
		const staticBody = await staticResponse.text();
		for (const secret of Object.values(secrets))
			assert.ok(!staticBody.includes(secret));

		await Promise.all(
			Object.values(names).map((name) => assertNoSecretFilesOrBundles(name)),
		);
		await runAdminProxySmoke({ network: infrastructure.network, label });

		await run('docker', ['stop', '--time', '1', names.telemetryApi], {
			stdio: 'ignore',
		});
		await waitForHttp(`http://127.0.0.1:${ports.adminWeb}/health/ready`, {
			expectedStatus: 503,
			timeoutMs: 10_000,
		});
		const stillLive = await fetch(
			`http://127.0.0.1:${ports.adminWeb}/health/live`,
		);
		assert.equal(stillLive.status, 200);
		await stillLive.body?.cancel();
		const unavailableServicesPage = await fetch(
			`http://127.0.0.1:${ports.adminWeb}/services`,
			{ headers: authenticatedHeaders },
		);
		assert.equal(unavailableServicesPage.status, 200);
		const unavailableServicesHtml = await unavailableServicesPage.text();
		assert.match(
			unavailableServicesHtml,
			/텔레메트리 API에 연결할 수 없습니다\. fixture 없이 빈 상태를 표시합니다\./,
		);
		assert.doesNotMatch(unavailableServicesHtml, /fixture 데이터로 표시합니다/);

		console.log(
			`Admin Docker smoke 통과: telemetry-api=${ports.telemetryApi}, admin-web=${ports.adminWeb}`,
		);
	} catch (error) {
		primaryError = error;
		for (const name of Object.values(names)) {
			const logs = await runCapture('docker', ['logs', '--tail', '200', name], {
				includeStderr: true,
			}).catch(() => '');
			if (logs) console.error(`\n--- ${name} logs ---\n${logs}`);
		}
	} finally {
		const cleanupErrors = [];
		try {
			await removeAppContainers();
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (manageInfrastructure) {
			try {
				await stopInfrastructure(infrastructure);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		try {
			await assertCleaned();
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (cleanupErrors.length) {
			const cleanupError = new AggregateError(
				cleanupErrors,
				'admin Docker smoke cleanup failed',
			);
			primaryError = primaryError
				? new AggregateError(
						[primaryError, cleanupError],
						'smoke and cleanup failed',
					)
				: cleanupError;
		}
	}

	if (primaryError) throw primaryError;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await runAdminDockerSmoke();
}
