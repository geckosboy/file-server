import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');
const cwd = fileURLToPath(new URL('../', import.meta.url));
export const configs = [
	'libs/global/tsconfig.build.json',
	'libs/image-contracts/tsconfig.build.json',
	'libs/nest-common/tsconfig.build.json',
	'scripts/tsconfig.database-typecheck.json',
	'libs/telemetry-contracts/tsconfig.build.json',
	'apps/storage/tsconfig.build.json',
	'apps/cache/tsconfig.build.json',
	'apps/resize/tsconfig.build.json',
	'apps/telemetry-api/tsconfig.build.json',
	'apps/lifecycle-consumer-tester/tsconfig.build.json',
	'apps/admin-web/tsconfig.json',
	'apps/admin-web/tsconfig.spec.json',
];

export const generatedTypeCommands = [
	['pnpm', ['--filter', '@file/admin-web', 'exec', 'next', 'typegen']],
	['pnpm', ['db:generate']],
];

export function runTypecheck({ spawn = spawnSync, log = console.log } = {}) {
	log(`Repository TypeScript ${require('typescript/package.json').version}`);

	for (const [command, args] of generatedTypeCommands) {
		const result = spawn(command, args, { cwd, stdio: 'inherit' });
		if (result.error) console.error(result.error.message);
		if (result.status !== 0) return result.status ?? 1;
	}

	for (const config of configs) {
		log(`[typecheck] ${config}`);
		const result = spawn(
			process.execPath,
			[tsc, '-p', config, '--noEmit', '--pretty', 'false'],
			{ cwd, stdio: 'inherit' },
		);
		if (result.error) console.error(result.error.message);
		if (result.status !== 0) return result.status ?? 1;
	}

	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = runTypecheck();
}
