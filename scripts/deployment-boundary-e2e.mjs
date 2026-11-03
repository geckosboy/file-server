import assert from 'node:assert/strict';
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
	for (const [app, port] of [
		['storage', 3032],
		['resize', 3031],
		['cache', 3030],
	]) {
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
			'--network',
			networks[0],
			'--publish',
			`127.0.0.1::${port}`,
			`file-server/${app}:local`,
		]);
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
			[...networks].sort(),
		);
	}
	console.log(
		JSON.stringify({
			event: 'deployment_boundary_passed',
			scope,
			apps: 3,
			hostBind: '127.0.0.1',
			containerBind: '0.0.0.0',
			networksPerApp: 2,
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
