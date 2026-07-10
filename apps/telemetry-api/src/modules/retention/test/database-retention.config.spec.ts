import { readDatabaseRetentionConfig } from '../database-retention.config';

describe('database retention config', () => {
	it('uses bounded Stage 3 defaults and disables the scheduler in tests', () => {
		expect(readDatabaseRetentionConfig({ NODE_ENV: 'test' })).toEqual({
			enabled: false,
			intervalMs: 0,
			telemetryDays: 90,
			lifecycleDays: 0,
			adminAuditDays: 0,
			batchSize: 250,
			maxBatchesPerRun: 20,
			batchSleepMs: 100,
			lockTimeoutMs: 1_000,
		});
	});

	it('keeps lifecycle and audit retention independently configurable', () => {
		expect(
			readDatabaseRetentionConfig({
				NODE_ENV: 'production',
				DATA_RETENTION_ENABLED: 'true',
				DATA_RETENTION_INTERVAL_MS: '3600000',
				TELEMETRY_RETENTION_DAYS: '120',
				LIFECYCLE_EVENT_RETENTION_DAYS: '730',
				ADMIN_AUDIT_RETENTION_DAYS: '1095',
				DATA_RETENTION_BATCH_SIZE: '100',
				DATA_RETENTION_MAX_BATCHES_PER_RUN: '5',
				DATA_RETENTION_BATCH_SLEEP_MS: '25',
				DATA_RETENTION_LOCK_TIMEOUT_MS: '500',
			}),
		).toEqual({
			enabled: true,
			intervalMs: 3_600_000,
			telemetryDays: 120,
			lifecycleDays: 730,
			adminAuditDays: 1_095,
			batchSize: 100,
			maxBatchesPerRun: 5,
			batchSleepMs: 25,
			lockTimeoutMs: 500,
		});
	});

	it('requires an explicit boolean scheduler gate', () => {
		expect(() =>
			readDatabaseRetentionConfig({ DATA_RETENTION_ENABLED: 'yes' }),
		).toThrow('DATA_RETENTION_ENABLED');
	});

	it.each([
		['TELEMETRY_RETENTION_DAYS', '0'],
		['LIFECYCLE_EVENT_RETENTION_DAYS', '-1'],
		['ADMIN_AUDIT_RETENTION_DAYS', '1.5'],
		['DATA_RETENTION_BATCH_SIZE', '10001'],
		['DATA_RETENTION_LOCK_TIMEOUT_MS', '0'],
	])('rejects unsafe %s=%s instead of widening deletion', (name, value) => {
		expect(() =>
			readDatabaseRetentionConfig({ NODE_ENV: 'test', [name]: value }),
		).toThrow(name);
	});
});
