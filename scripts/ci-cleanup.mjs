import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const modes = {
	system: {
		envName: 'SYSTEM_E2E_COMPOSE_PROJECT',
		composeFile: resolve(
			repositoryRoot,
			'docker/docker-compose.system-e2e.yml',
		),
	},
	acl: {
		envName: 'KAFKA_ACL_E2E_PROJECT',
		composeFile: resolve(
			repositoryRoot,
			'docker/docker-compose.kafka-acl-e2e.yml',
		),
	},
};

if (!(mode in modes)) {
	throw new Error('Usage: node scripts/ci-cleanup.mjs system|acl');
}
const config = modes[mode];
const project = process.env[config.envName];
if (!project || !/^fs-(system|lifecycle|smoke|acl)-ci-\d+-\d+$/.test(project)) {
	throw new Error(
		`${config.envName} is missing or is not a bounded CI project`,
	);
}

const runDocker = (args) =>
	new Promise((resolveRun, rejectRun) => {
		const child = spawn('docker', args, {
			cwd: repositoryRoot,
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.once('error', rejectRun);
		child.once('exit', (code, signal) => {
			if (code === 0) {
				resolveRun(Buffer.concat(stdout).toString('utf8').trim());
				return;
			}
			rejectRun(
				new Error(
					`docker command failed (code=${code ?? 'null'}, signal=${signal ?? 'none'}): ${Buffer.concat(stderr).toString('utf8').trim()}`,
				),
			);
		});
	});

const resourceCommands = {
	container: { list: ['ps', '-aq'], remove: ['rm', '--force'] },
	network: { list: ['network', 'ls', '-q'], remove: ['network', 'rm'] },
	volume: { list: ['volume', 'ls', '-q'], remove: ['volume', 'rm', '--force'] },
};
const composeLabel = `com.docker.compose.project=${project}`;
const standaloneLabel = `io.file-server.test-project=${project}`;
const failures = [];

const attempt = async (operation) => {
	try {
		return await operation();
	} catch (error) {
		failures.push(error);
		return undefined;
	}
};

await attempt(() =>
	runDocker([
		'compose',
		'-f',
		config.composeFile,
		'-p',
		project,
		'down',
		'--volumes',
		'--remove-orphans',
	]),
);

for (const { list, remove } of Object.values(resourceCommands)) {
	const output = await attempt(() =>
		runDocker([...list, '--filter', `label=${standaloneLabel}`]),
	);
	const resources = output ? output.split(/\s+/).filter(Boolean) : [];
	if (resources.length > 0)
		await attempt(() => runDocker([...remove, ...resources]));
}

for (const { list } of Object.values(resourceCommands)) {
	for (const label of [composeLabel, standaloneLabel]) {
		const remaining = await attempt(() =>
			runDocker([...list, '--filter', `label=${label}`]),
		);
		if (remaining) {
			failures.push(new Error(`cleanup left labelled resources: ${label}`));
		}
	}
}

if (failures.length > 0) {
	throw new AggregateError(failures, `CI cleanup failed for ${project}`);
}
console.log(`CI cleanup complete for ${project}`);
