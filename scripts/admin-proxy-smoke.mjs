import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	getFreePort,
	repoRoot,
	run,
	runCapture,
	sleep,
} from './system-test-utils.mjs';

const backendProgram = String.raw`
const http = require('node:http');
const instance = process.env.BACKEND_INSTANCE;
const expectedSecret = process.env.EXPECTED_PROXY_SECRET;
http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({
    instance,
    actor: request.headers['x-file-admin-user'],
    secretValid: request.headers['x-file-admin-proxy-secret'] === expectedSecret,
    forgedActorForwarded: request.headers['x-file-admin-user'] === 'forged-admin',
    forgedSecretForwarded: request.headers['x-file-admin-proxy-secret'] === 'forged-secret',
  }));
}).listen(3000, '0.0.0.0');
`;

export async function runAdminProxySmoke({ network, label }) {
	assert.match(network ?? '', /^[A-Za-z0-9][A-Za-z0-9_.-]+$/);
	assert.match(label ?? '', /^[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+$/);

	const suffix = `${process.pid}-${Date.now()}`;
	const alias = `admin-proxy-target-${suffix}`;
	const names = {
		backend: `fs-admin-proxy-backend-${suffix}`,
		nginx: `fs-admin-proxy-nginx-${suffix}`,
		spacer: `fs-admin-proxy-spacer-${suffix}`,
	};
	const directory = await mkdtemp(
		path.join(tmpdir(), 'file-server-admin-proxy-'),
	);
	const configPath = path.join(directory, 'default.conf');
	const certificatePath = path.join(directory, 'admin-fullchain.pem');
	const privateKeyPath = path.join(directory, 'admin-privkey.pem');
	const passwordPath = path.join(directory, 'admin.htpasswd');
	const port = await getFreePort();
	const proxySecret = 'admin-proxy-smoke-secret-not-for-production';
	const basicUser = 'admin-smoke-operator';
	const basicPassword = 'admin-smoke-password';

	const startBackend = async (instance) => {
		await run('docker', [
			'run',
			'--detach',
			'--name',
			names.backend,
			'--label',
			label,
			'--network',
			network,
			'--network-alias',
			alias,
			'--env',
			`BACKEND_INSTANCE=${instance}`,
			'--env',
			`EXPECTED_PROXY_SECRET=${proxySecret}`,
			'node:22.15.0-alpine',
			'node',
			'-e',
			backendProgram,
		]);
	};

	const backendIp = () =>
		runCapture('docker', [
			'inspect',
			'--format',
			`{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
			names.backend,
		]);

	const request = async ({ authenticated = false, forged = false } = {}) => {
		const args = [
			'--silent',
			'--show-error',
			'--connect-timeout',
			'1',
			'--max-time',
			'3',
			'--insecure',
			'--output',
			'-',
			'--write-out',
			'\n%{http_code}',
		];
		if (authenticated) args.push('--user', `${basicUser}:${basicPassword}`);
		if (forged)
			args.push(
				'--header',
				'X-File-Admin-User: forged-admin',
				'--header',
				'X-File-Admin-Proxy-Secret: forged-secret',
			);
		args.push(`https://127.0.0.1:${port}/`);
		const output = await runCapture('curl', args);
		const separator = output.lastIndexOf('\n');
		assert.ok(separator > -1, 'curl status separator missing');
		return {
			body: output.slice(0, separator),
			status: Number(output.slice(separator + 1)),
		};
	};

	let primaryError;
	try {
		const template = await readFile(
			path.join(repoRoot, 'docker/nginx/admin.conf.example'),
			'utf8',
		);
		assert.match(template, /resolver 127\.0\.0\.11 valid=5s ipv6=off;/);
		assert.match(template, /proxy_pass http:\/\/\$admin_web_upstream;/);
		const config = template
			.replace('admin.example.com', 'localhost')
			.replace('file_server_admin-web:3000', `${alias}:3000`)
			.replace('REPLACE_WITH_ADMIN_WEB_PROXY_SECRET', proxySecret);
		await writeFile(configPath, config, { mode: 0o600 });
		await run(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-days',
				'1',
				'-subj',
				'/CN=localhost',
				'-keyout',
				privateKeyPath,
				'-out',
				certificatePath,
			],
			{ stdio: 'ignore' },
		);
		const passwordHash = await runCapture('openssl', [
			'passwd',
			'-apr1',
			basicPassword,
		]);
		await writeFile(passwordPath, `${basicUser}:${passwordHash}\n`, {
			// Synthetic credential: the Linux Nginx worker must read this mounted file.
			// Its host parent remains 0700 and the container mount is read-only.
			mode: 0o644,
		});

		await startBackend('old');
		const oldIp = await backendIp();
		await run('docker', [
			'run',
			'--detach',
			'--name',
			names.nginx,
			'--label',
			label,
			'--network',
			network,
			'--publish',
			`127.0.0.1:${port}:443`,
			'--volume',
			`${configPath}:/etc/nginx/conf.d/default.conf:ro`,
			'--volume',
			`${certificatePath}:/run/secrets/admin-fullchain.pem:ro`,
			'--volume',
			`${privateKeyPath}:/run/secrets/admin-privkey.pem:ro`,
			'--volume',
			`${passwordPath}:/run/secrets/admin.htpasswd:ro`,
			'nginx:alpine',
		]);
		await run('docker', ['exec', names.nginx, 'nginx', '-t']);

		let anonymous;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			try {
				anonymous = await request();
				break;
			} catch {
				await sleep(250);
			}
		}
		assert.equal(anonymous?.status, 401);
		assert.equal((await request({ forged: true })).status, 401);
		const authenticated = await request({ authenticated: true, forged: true });
		assert.equal(authenticated.status, 200);
		assert.ok(!authenticated.body.includes(proxySecret));
		assert.deepEqual(JSON.parse(authenticated.body), {
			instance: 'old',
			actor: basicUser,
			secretValid: true,
			forgedActorForwarded: false,
			forgedSecretForwarded: false,
		});

		await run('docker', ['rm', '--force', names.backend], { stdio: 'ignore' });
		await run('docker', [
			'run',
			'--detach',
			'--name',
			names.spacer,
			'--label',
			label,
			'--network',
			network,
			'node:22.15.0-alpine',
			'sleep',
			'300',
		]);
		await startBackend('new');
		const newIp = await backendIp();
		assert.notEqual(newIp, oldIp, 'replacement backend must use a new IP');

		let replacement;
		for (let attempt = 0; attempt < 60; attempt += 1) {
			await sleep(250);
			try {
				const response = await request({ authenticated: true, forged: true });
				if (
					response.status === 200 &&
					JSON.parse(response.body).instance === 'new'
				) {
					replacement = response;
					break;
				}
			} catch {
				// Expected while Docker DNS and the resolver cache converge.
			}
		}
		assert.equal(replacement?.status, 200, 'Nginx did not re-resolve backend');
		assert.ok(!replacement.body.includes(proxySecret));
		assert.equal(JSON.parse(replacement.body).secretValid, true);
		console.log(
			`Admin proxy smoke 통과: nginx=${port}, backend=${oldIp}->${newIp}`,
		);
	} catch (error) {
		primaryError = error;
		const logs = await runCapture(
			'docker',
			['logs', '--tail', '200', names.nginx],
			{ includeStderr: true },
		).catch(() => '');
		if (logs) console.error(`\n--- ${names.nginx} logs ---\n${logs}`);
	} finally {
		const cleanupErrors = [];
		for (const name of Object.values(names).reverse()) {
			await run('docker', ['rm', '--force', name], { stdio: 'ignore' }).catch(
				async (error) => {
					const exists = await runCapture('docker', [
						'ps',
						'-aq',
						'--filter',
						`name=^/${name}$`,
					]);
					if (exists) cleanupErrors.push(error);
				},
			);
		}
		await rm(directory, { recursive: true, force: true }).catch((error) =>
			cleanupErrors.push(error),
		);
		const remaining = await runCapture('docker', [
			'ps',
			'-aq',
			'--filter',
			`label=${label}`,
			'--filter',
			'name=fs-admin-proxy-',
		]);
		if (remaining)
			cleanupErrors.push(
				new Error('admin proxy containers remain after cleanup'),
			);
		if (cleanupErrors.length) {
			const cleanupError = new AggregateError(
				cleanupErrors,
				'admin proxy cleanup failed',
			);
			primaryError = primaryError
				? new AggregateError(
						[primaryError, cleanupError],
						'proxy smoke and cleanup failed',
					)
				: cleanupError;
		}
	}

	if (primaryError) throw primaryError;
}
