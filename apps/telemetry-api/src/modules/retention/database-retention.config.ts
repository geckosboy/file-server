import { Provider } from '@nestjs/common';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DATABASE_RETENTION_CONFIG = Symbol('DATABASE_RETENTION_CONFIG');

export interface DatabaseRetentionConfig {
	enabled: boolean;
	intervalMs: number;
	telemetryDays: number;
	lifecycleDays: number;
	adminAuditDays: number;
	batchSize: number;
	maxBatchesPerRun: number;
	batchSleepMs: number;
	lockTimeoutMs: number;
}

export const databaseRetentionConfigProvider: Provider = {
	provide: DATABASE_RETENTION_CONFIG,
	useFactory: () => readDatabaseRetentionConfig(),
};

export const readDatabaseRetentionConfig = (
	env: NodeJS.ProcessEnv = process.env,
): DatabaseRetentionConfig => ({
	enabled: readBoolean(env.DATA_RETENTION_ENABLED, false),
	intervalMs: readInteger(
		env.DATA_RETENTION_INTERVAL_MS,
		env.NODE_ENV === 'test' ? 0 : DAY_MS,
		'DATA_RETENTION_INTERVAL_MS',
		0,
	),
	telemetryDays: readInteger(
		env.TELEMETRY_RETENTION_DAYS,
		90,
		'TELEMETRY_RETENTION_DAYS',
		1,
	),
	lifecycleDays: readInteger(
		env.LIFECYCLE_EVENT_RETENTION_DAYS,
		0,
		'LIFECYCLE_EVENT_RETENTION_DAYS',
		0,
	),
	adminAuditDays: readInteger(
		env.ADMIN_AUDIT_RETENTION_DAYS,
		0,
		'ADMIN_AUDIT_RETENTION_DAYS',
		0,
	),
	batchSize: readInteger(
		env.DATA_RETENTION_BATCH_SIZE,
		250,
		'DATA_RETENTION_BATCH_SIZE',
		1,
		10_000,
	),
	maxBatchesPerRun: readInteger(
		env.DATA_RETENTION_MAX_BATCHES_PER_RUN,
		20,
		'DATA_RETENTION_MAX_BATCHES_PER_RUN',
		1,
		1_000,
	),
	batchSleepMs: readInteger(
		env.DATA_RETENTION_BATCH_SLEEP_MS,
		100,
		'DATA_RETENTION_BATCH_SLEEP_MS',
		0,
		60_000,
	),
	lockTimeoutMs: readInteger(
		env.DATA_RETENTION_LOCK_TIMEOUT_MS,
		1_000,
		'DATA_RETENTION_LOCK_TIMEOUT_MS',
		1,
		60_000,
	),
});

const readBoolean = (value: string | undefined, fallback: boolean): boolean => {
	if (value === undefined || value.trim() === '') {
		return fallback;
	}
	if (value === 'true') {
		return true;
	}
	if (value === 'false') {
		return false;
	}
	throw new Error('DATA_RETENTION_ENABLED must be true or false.');
};

const readInteger = (
	value: string | undefined,
	fallback: number,
	name: string,
	minimum: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number => {
	if (value === undefined || value.trim() === '') {
		return fallback;
	}

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(
			`${name} must be an integer between ${minimum} and ${maximum}.`,
		);
	}
	return parsed;
};
