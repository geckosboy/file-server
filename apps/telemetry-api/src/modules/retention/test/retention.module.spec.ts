import {
	RetentionModule,
	createRetentionModuleImports,
} from '../retention.module';

describe('retention module wiring', () => {
	it.each([
		[{ NODE_ENV: 'test' }],
		[{ NODE_ENV: 'development', TELEMETRY_STORAGE_DRIVER: 'memory' }],
		[{ NODE_ENV: 'development', LIFECYCLE_STORAGE_DRIVER: 'memory' }],
	])('does not require PostgreSQL for test or memory mode: %p', (env) => {
		expect(createRetentionModuleImports(env)).toEqual([]);
	});

	it('enables PostgreSQL retention for database-backed runtimes', () => {
		expect(createRetentionModuleImports({ NODE_ENV: 'production' })).toEqual([
			RetentionModule,
		]);
	});
});
