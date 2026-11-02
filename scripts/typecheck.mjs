import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');
const cwd = fileURLToPath(new URL('../', import.meta.url));
const configs = [
	'libs/global/tsconfig.build.json',
	'libs/image-contracts/tsconfig.build.json',
	'libs/nest-common/tsconfig.build.json',
	'libs/database/tsconfig.build.json',
	'libs/telemetry-contracts/tsconfig.build.json',
	'apps/storage/tsconfig.build.json',
	'apps/cache/tsconfig.build.json',
	'apps/resize/tsconfig.build.json',
	'apps/telemetry-api/tsconfig.build.json',
	'apps/lifecycle-consumer-tester/tsconfig.build.json',
	'apps/admin-web/tsconfig.json',
	'apps/admin-web/tsconfig.spec.json',
];

console.log(
	`Repository TypeScript ${require('typescript/package.json').version}`,
);
// Validate Next's route export contract even in a clean checkout, before build.
const typegen = spawnSync(
	'pnpm',
	['--filter', '@file/admin-web', 'exec', 'next', 'typegen'],
	{ cwd, stdio: 'inherit' },
);
if (typegen.error) console.error(typegen.error.message);
if (typegen.status !== 0) process.exit(typegen.status ?? 1);

for (const config of configs) {
	console.log(`[typecheck] ${config}`);
	const result = spawnSync(
		process.execPath,
		[tsc, '-p', config, '--noEmit', '--pretty', 'false'],
		{ cwd, stdio: 'inherit' },
	);
	if (result.error) console.error(result.error.message);
	if (result.status !== 0) process.exit(result.status ?? 1);
}
