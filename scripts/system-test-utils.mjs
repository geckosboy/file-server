import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const composeFile = resolve(
	repoRoot,
	'docker/docker-compose.system-e2e.yml',
);

export const sleep = (milliseconds) =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

export const getFreePort = async () => {
	const server = createServer();
	server.unref();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		throw new Error('사용 가능한 TCP 포트를 찾지 못했습니다.');
	}
	const { port } = address;
	server.close();
	await once(server, 'close');
	return port;
};

export const run = (command, args, options = {}) =>
	new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? repoRoot,
			env: options.env ?? process.env,
			stdio: options.stdio ?? 'inherit',
		});
		child.once('error', rejectRun);
		child.once('exit', (code, signal) => {
			if (code === 0) {
				resolveRun();
				return;
			}
			rejectRun(
				new Error(
					`${command} ${args.join(' ')} 실패 (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
				),
			);
		});
	});

export const runCapture = (command, args, options = {}) =>
	new Promise((resolveRun, rejectRun) => {
		const stdout = [];
		const stderr = [];
		const child = spawn(command, args, {
			cwd: options.cwd ?? repoRoot,
			env: options.env ?? process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.once('error', rejectRun);
		child.once('exit', (code, signal) => {
			const output = Buffer.concat(stdout).toString('utf8').trim();
			const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
			if (code === 0) {
				resolveRun(
					options.includeStderr
						? [output, errorOutput].filter(Boolean).join('\n')
						: output,
				);
				return;
			}
			rejectRun(
				new Error(
					`${command} ${args.join(' ')} 실패 (code=${code ?? 'null'}, signal=${signal ?? 'none'}): ${errorOutput}`,
				),
			);
		});
	});

export const createInfrastructureConfig = async (scope) => {
	const postgresPort = Number(
		process.env.SYSTEM_E2E_POSTGRES_PORT || (await getFreePort()),
	);
	const kafkaPort = Number(
		process.env.SYSTEM_E2E_KAFKA_PORT || (await getFreePort()),
	);
	const suffix = `${scope}-${process.pid}`
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-');
	const project = process.env.SYSTEM_E2E_COMPOSE_PROJECT ?? `fs-${suffix}`;
	const network = process.env.SYSTEM_E2E_NETWORK ?? `fs-${suffix}`;
	const env = {
		...process.env,
		SYSTEM_E2E_COMPOSE_PROJECT: project,
		SYSTEM_E2E_NETWORK: network,
		SYSTEM_E2E_POSTGRES_PORT: String(postgresPort),
		SYSTEM_E2E_KAFKA_PORT: String(kafkaPort),
	};

	return {
		env,
		project,
		network,
		postgresPort,
		kafkaPort,
		databaseUrl: `postgresql://file_server:file_server@127.0.0.1:${postgresPort}/file_server`,
		kafkaBroker: `127.0.0.1:${kafkaPort}`,
	};
};

export const startInfrastructure = async (config) => {
	await run('docker', ['info'], { stdio: 'ignore' });
	await run(
		'docker',
		[
			'compose',
			'-f',
			composeFile,
			'-p',
			config.project,
			'up',
			'--detach',
			'--wait',
			'--wait-timeout',
			'120',
		],
		{ env: config.env },
	);
	for (const topic of ['file.image.events.v1', 'file.image.lifecycle.v1']) {
		await run(
			'docker',
			[
				'compose',
				'-f',
				composeFile,
				'-p',
				config.project,
				'exec',
				'--no-TTY',
				'kafka',
				'/opt/kafka/bin/kafka-topics.sh',
				'--bootstrap-server',
				'kafka:9092',
				'--create',
				'--if-not-exists',
				'--topic',
				topic,
				'--partitions',
				'1',
				'--replication-factor',
				'1',
			],
			{ env: config.env },
		);
	}
};

export const stopInfrastructure = async (config) => {
	await run(
		'docker',
		[
			'compose',
			'-f',
			composeFile,
			'-p',
			config.project,
			'down',
			'--volumes',
			'--remove-orphans',
		],
		{ env: config.env, stdio: 'inherit' },
	).catch((error) => {
		console.error(`테스트 인프라 정리 실패: ${error.message}`);
	});
};

export const migrateDatabase = (config) =>
	run('pnpm', ['db:migrate:deploy'], {
		env: { ...process.env, DATABASE_URL: config.databaseUrl },
	});

export const waitForHttp = async (
	url,
	{ headers, expectedStatus = 200, timeoutMs = 30_000, child } = {},
) => {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		if (child && (child.exitCode !== null || child.signalCode !== null)) {
			throw new Error(`${child.serviceName}가 준비되기 전에 종료되었습니다.`);
		}
		try {
			const response = await fetch(url, { headers });
			if (response.status === expectedStatus) {
				return response;
			}
			lastError = new Error(`HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await sleep(250);
	}
	throw new Error(
		`${url} 준비 대기 시간 초과: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
};

export const spawnService = ({ name, entry, env }) => {
	const lines = [];
	const child = spawn(process.execPath, [resolve(repoRoot, entry)], {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.serviceName = name;
	const capture = (chunk) => {
		lines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
		if (lines.length > 2_000) {
			lines.splice(0, lines.length - 2_000);
		}
	};
	child.stdout.on('data', capture);
	child.stderr.on('data', capture);
	child.capturedLines = lines;
	return child;
};

export const stopChild = async (child) => {
	if (!child || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	const exited = once(child, 'exit');
	child.kill('SIGTERM');
	await Promise.race([exited, sleep(5_000)]);
	if (child.exitCode === null && child.signalCode === null) {
		const killed = once(child, 'exit');
		child.kill('SIGKILL');
		await killed.catch(() => undefined);
	}
};

export const printChildLogs = (children) => {
	for (const child of children) {
		if (!child.capturedLines?.length) {
			continue;
		}
		console.error(`\n--- ${child.serviceName} logs ---`);
		console.error(child.capturedLines.slice(-200).join('\n'));
	}
};

export const fetchJson = async (url, options = {}, expectedStatus = 200) => {
	const response = await fetch(url, options);
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = text;
	}
	if (response.status !== expectedStatus) {
		throw new Error(
			`${options.method ?? 'GET'} ${url}: HTTP ${response.status} ${JSON.stringify(body)}`,
		);
	}
	return body;
};

export const poll = async (assertion, options = {}) => {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const intervalMs = options.intervalMs ?? 300;
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			return await assertion();
		} catch (error) {
			lastError = error;
			await sleep(intervalMs);
		}
	}
	throw lastError ?? new Error('poll timeout');
};
