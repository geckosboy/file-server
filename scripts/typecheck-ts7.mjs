#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const TYPESCRIPT_VERSION = process.env.TYPESCRIPT_7_VERSION ?? '7.0.2';
const TSC_COMMAND = [
	'--silent',
	'dlx',
	'--package',
	`typescript@${TYPESCRIPT_VERSION}`,
	'tsc',
];

const TYPECHECK_CONFIGS = [
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

const runTsc = (args) => {
	const result = spawnSync('pnpm', [...TSC_COMMAND, ...args], {
		stdio: 'inherit',
		shell: false,
	});

	return result.status ?? 1;
};

console.log(`TypeScript ${TYPESCRIPT_VERSION} 임시 typecheck를 시작합니다.`);

const versionStatus = runTsc(['--version']);
if (versionStatus !== 0) {
	process.exit(versionStatus);
}

for (const config of TYPECHECK_CONFIGS) {
	console.log(`\n[ts7] ${config}`);
	const status = runTsc([
		'-p',
		config,
		'--noEmit',
		'--pretty',
		'false',
	]);

	if (status !== 0) {
		process.exit(status);
	}
}

console.log('\nTypeScript 7 임시 typecheck가 통과했습니다.');
