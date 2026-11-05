import assert from 'node:assert/strict';
import { appsForGroups, parseGroups } from './ci-images.mjs';
import { randomUUID } from 'node:crypto';
import { run, runCapture } from './system-test-utils.mjs';

// Configuration-only Docker rehearsal: no production credentials or app startup.
const scope = `fs-deploy-boundary-${randomUUID().slice(0, 8)}`;
const label = `io.file-server.deployment-boundary=${scope}`;
const ciProject = process.env.SYSTEM_E2E_COMPOSE_PROJECT;
const ciLabel = ciProject
	? `io.file-server.test-project=${ciProject}`
	: undefined;
const networks = [`${scope}-files`, `${scope}-kafka`];
const containers = [];
const apps = appsForGroups(parseGroups(process.argv[2] ?? 'runtime'));
const ports = {
	storage: 3032,
	resize: 3031,
	cache: 3030,
	'telemetry-api': 3100,
	'admin-web': 3000,
};
try {
	for (const network of networks) {
		await run('docker', [
			'network',
			'create',
			'--label',
			label,
			...(ciLabel ? ['--label', ciLabel] : []),
			network,
		]);
	}
	for (const app of apps) {
		const port = ports[app];
		const appNetworks = app === 'admin-web' ? [networks[0]] : networks;
		const name = `${scope}-${app}`;
		containers.push(name);
		await run('docker', [
			'create',
			'--name',
			name,
			'--label',
			label,
			...(ciLabel ? ['--label', ciLabel] : []),
			'--env',
			'HOST=0.0.0.0',
			'--env',
			'HOSTNAME=0.0.0.0',
			'--network',
			networks[0],
			'--publish',
			`127.0.0.1::${port}`,
			process.env[`${app.replaceAll('-', '_').toUpperCase()}_IMAGE`] ??
				`file-server/${app}:local`,
		]);
		if (appNetworks.length > 1)
			await run('docker', ['network', 'connect', networks[1], name]);
		const [inspect] = JSON.parse(await runCapture('docker', ['inspect', name]));
		assert.equal(inspect.State.Running, false);
		assert.equal(
			inspect.HostConfig.PortBindings[`${port}/tcp`][0].HostIp,
			'127.0.0.1',
		);
		assert.ok(inspect.Config.Env.includes('HOST=0.0.0.0'));
		assert.deepEqual(
			Object.keys(inspect.NetworkSettings.Networks).sort(),
			[...appNetworks].sort(),
		);
	}
	console.log(
		JSON.stringify({
			event: 'deployment_boundary_passed',
			scope,
			apps: apps.length,
			hostBind: '127.0.0.1',
			containerBind: '0.0.0.0',
			adminWebKafkaAccess: false,
		}),
	);
} finally {
	for (const name of containers.reverse()) {
		await run('docker', ['rm', '--force', '--volumes', name], {
			stdio: 'ignore',
		}).catch(() => undefined);
	}
	for (const network of [...networks].reverse()) {
		await run('docker', ['network', 'rm', network], { stdio: 'ignore' }).catch(
			() => undefined,
		);
	}
	assert.equal(
		await runCapture('docker', ['ps', '-aq', '--filter', `label=${label}`]),
		'',
	);
	assert.equal(
		await runCapture('docker', [
			'network',
			'ls',
			'-q',
			'--filter',
			`label=${label}`,
		]),
		'',
	);
	console.log(
		JSON.stringify({ event: 'deployment_boundary_cleanup_passed', scope }),
	);
}
