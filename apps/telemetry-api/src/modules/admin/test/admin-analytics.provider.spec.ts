import { PrismaModule } from '@file/database';
import {
	ADMIN_ANALYTICS_REPOSITORY,
	createAdminAnalyticsImports,
	createAdminAnalyticsProviders,
} from '../admin-analytics.provider';
import { PrismaAdminAnalyticsRepository } from '../prisma-admin-analytics.repository';
import { InMemoryAdminAnalyticsRepository } from '../in-memory-admin-analytics.repository';

describe('admin analytics provider wiring', () => {
	it.each([
		{ NODE_ENV: 'test' },
		{ NODE_ENV: 'development', TELEMETRY_STORAGE_DRIVER: 'memory' },
	])('keeps the in-memory adapter for %p', (env) => {
		expect(createAdminAnalyticsImports(env)).toEqual([]);
		expect(createAdminAnalyticsProviders(env)).toEqual([
			{
				provide: ADMIN_ANALYTICS_REPOSITORY,
				useClass: InMemoryAdminAnalyticsRepository,
			},
		]);
	});

	it('wires Prisma analytics for database-backed production', () => {
		expect(createAdminAnalyticsImports({ NODE_ENV: 'production' })).toEqual([
			PrismaModule,
		]);
		expect(createAdminAnalyticsProviders({ NODE_ENV: 'production' })).toEqual([
			{
				provide: ADMIN_ANALYTICS_REPOSITORY,
				useClass: PrismaAdminAnalyticsRepository,
			},
		]);
	});
});
