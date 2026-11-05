import { Provider } from '@nestjs/common';
import { PrismaModule } from '@file/database';
import { AdminAnalyticsRepository } from './admin-analytics.types';
import { InMemoryAdminAnalyticsRepository } from './in-memory-admin-analytics.repository';
import { PrismaAdminAnalyticsRepository } from './prisma-admin-analytics.repository';

export const ADMIN_ANALYTICS_REPOSITORY = Symbol('ADMIN_ANALYTICS_REPOSITORY');

interface AdminAnalyticsEnvironment {
	NODE_ENV?: string;
	TELEMETRY_STORAGE_DRIVER?: string;
}

export function createAdminAnalyticsImports(
	env: AdminAnalyticsEnvironment = process.env,
) {
	return shouldUseInMemoryAnalytics(env) ? [] : [PrismaModule];
}

export function createAdminAnalyticsProviders(
	env: AdminAnalyticsEnvironment = process.env,
): Provider<AdminAnalyticsRepository>[] {
	return [
		{
			provide: ADMIN_ANALYTICS_REPOSITORY,
			useClass: shouldUseInMemoryAnalytics(env)
				? InMemoryAdminAnalyticsRepository
				: PrismaAdminAnalyticsRepository,
		},
	];
}

function shouldUseInMemoryAnalytics(env: AdminAnalyticsEnvironment): boolean {
	return env.NODE_ENV === 'test' || env.TELEMETRY_STORAGE_DRIVER === 'memory';
}
