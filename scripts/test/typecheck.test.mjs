import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { configs, generatedTypeCommands, runTypecheck } from '../typecheck.mjs';

test('clean-checkout typechecking prepares generated types and uses workspace sources', () => {
	const databaseManifest = JSON.parse(
		readFileSync(
			new URL('../../libs/database/package.json', import.meta.url),
			'utf8',
		),
	);
	const databaseConfig = JSON.parse(
		readFileSync(
			new URL('../tsconfig.database-typecheck.json', import.meta.url),
			'utf8',
		),
	);
	const databaseTestConfig = JSON.parse(
		readFileSync(
			new URL('../../libs/database/tsconfig.spec.json', import.meta.url),
			'utf8',
		),
	);

	assert.deepEqual(generatedTypeCommands, [
		['pnpm', ['--filter', '@file/admin-web', 'exec', 'next', 'typegen']],
		['pnpm', ['db:generate']],
	]);
	assert.ok(configs.includes('scripts/tsconfig.database-typecheck.json'));
	assert.ok(!configs.includes('libs/database/tsconfig.build.json'));
	assert.deepEqual(databaseConfig.compilerOptions.paths, {
		'@file/image-contracts': ['libs/image-contracts/src'],
		'@file/image-contracts/*': ['libs/image-contracts/src/*'],
		'@file/telemetry-contracts': ['libs/telemetry-contracts/src'],
		'@file/telemetry-contracts/*': ['libs/telemetry-contracts/src/*'],
	});
	assert.deepEqual(databaseManifest.jest.transform['^.+\\.(t|j)s$'], [
		'ts-jest',
		{ tsconfig: '<rootDir>/../tsconfig.spec.json' },
	]);
	assert.equal(
		databaseTestConfig.extends,
		'../../scripts/tsconfig.database-typecheck.json',
	);
	assert.deepEqual(databaseTestConfig.include, ['src/**/*.ts']);
	assert.deepEqual(databaseTestConfig.exclude, ['node_modules', 'dist']);
	assert.deepEqual(databaseTestConfig.compilerOptions.types, ['node', 'jest']);
	assert.deepEqual(databaseManifest.jest.moduleNameMapper, {
		'^@file/image-contracts$': '<rootDir>/../../image-contracts/src',
		'^@file/image-contracts/(.*)$': '<rootDir>/../../image-contracts/src/$1',
		'^@file/telemetry-contracts$': '<rootDir>/../../telemetry-contracts/src',
		'^@file/telemetry-contracts/(.*)$':
			'<rootDir>/../../telemetry-contracts/src/$1',
	});

	const calls = [];
	assert.equal(
		runTypecheck({
			log: () => {},
			spawn: (command, args, options) => {
				calls.push({ command, args, options });
				return { status: 0 };
			},
		}),
		0,
	);
	assert.deepEqual(
		calls
			.slice(0, generatedTypeCommands.length)
			.map(({ command, args }) => [command, args]),
		generatedTypeCommands,
	);
	for (const { args } of calls.slice(generatedTypeCommands.length)) {
		assert.ok(args.includes('--noEmit'));
		assert.ok(!args.includes('--emitDeclarationOnly'));
	}
});
