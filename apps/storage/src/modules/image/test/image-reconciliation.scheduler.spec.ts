import { ImageAssetLifecycleService } from '.././image-asset-lifecycle.service';
import {
	ImageReconciliationScheduler,
	readImageReconciliationConfig,
} from '.././image-reconciliation.scheduler';

describe('이미지 reconciliation scheduler', () => {
	const originalInterval = process.env.IMAGE_RECONCILIATION_INTERVAL_MS;
	const originalLegacyCadence = process.env.IMAGE_RECONCILIATION_BATCH_SLEEP_MS;

	afterEach(() => {
		restoreEnv('IMAGE_RECONCILIATION_INTERVAL_MS', originalInterval);
		restoreEnv('IMAGE_RECONCILIATION_BATCH_SLEEP_MS', originalLegacyCadence);
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('기본 bounded scan의 interval+stale 타겟은 5분이다', () => {
		const config = readImageReconciliationConfig({});

		expect(config.enabled).toBe(true);
		expect(config.intervalMs + config.staleAfterMs).toBeLessThanOrEqual(
			5 * 60_000,
		);
		expect(config.leaseMs).toBeLessThan(config.intervalMs);
		expect(config.lockTimeoutMs).toBe(2_000);
		expect(config.batchSize).toBe(100);
		expect(config.objectScanLimit).toBe(1_000);
	});

	it('interval/lease/scan 상한을 환경변수로 조정한다', () => {
		expect(
			readImageReconciliationConfig({
				IMAGE_RECONCILIATION_ENABLED: 'false',
				IMAGE_RECONCILIATION_INTERVAL_MS: '30000',
				IMAGE_RECONCILIATION_BATCH_SLEEP_MS: '35000',
				IMAGE_RECONCILIATION_STALE_AFTER_MS: '90000',
				IMAGE_RECONCILIATION_LEASE_MS: '25000',
				IMAGE_RECONCILIATION_LOCK_TIMEOUT_MS: '1500',
				IMAGE_RECONCILIATION_BATCH_SIZE: '25',
				IMAGE_RECONCILIATION_OBJECT_SCAN_LIMIT: '200',
				IMAGE_RECONCILIATION_STAGE_CLEANUP_LIMIT: '50',
				IMAGE_RECONCILIATION_INBOUND_TEMP_CLEANUP_LIMIT: '40',
				IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED: 'true',
			}),
		).toEqual({
			enabled: false,
			intervalMs: 30_000,
			staleAfterMs: 90_000,
			leaseMs: 25_000,
			lockTimeoutMs: 1_500,
			batchSize: 25,
			objectScanLimit: 200,
			stageCleanupLimit: 50,
			inboundTempCleanupLimit: 40,
			orphanDeleteEnabled: true,
		});
	});

	it('명시적 interval이 없는 기존 배포는 batch sleep 값을 cadence 호환 별칭으로 사용한다', () => {
		expect(
			readImageReconciliationConfig({
				IMAGE_RECONCILIATION_BATCH_SLEEP_MS: '35000',
			}),
		).toEqual(expect.objectContaining({ intervalMs: 35_000 }));
	});

	it('명시적 interval이 기존 batch sleep cadence 별칭보다 우선한다', () => {
		expect(
			readImageReconciliationConfig({
				IMAGE_RECONCILIATION_INTERVAL_MS: '30000',
				IMAGE_RECONCILIATION_BATCH_SLEEP_MS: '35000',
			}),
		).toEqual(expect.objectContaining({ intervalMs: 30_000 }));
	});

	it('같은 프로세스의 중복 tick을 합치고 bounded reconciliation 입력을 전달한다', async () => {
		jest.useFakeTimers();
		let resolveRun: (() => void) | undefined;
		const reconcile = jest.fn().mockReturnValue(
			new Promise((resolve) => {
				resolveRun = () =>
					resolve({
						leaseAcquired: false,
					});
			}),
		);
		const scheduler = new ImageReconciliationScheduler({
			reconcile,
		} as unknown as ImageAssetLifecycleService);

		scheduler.onModuleInit();
		jest.advanceTimersByTime(3 * 60_000);
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(reconcile).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 100,
				objectScanLimit: 1_000,
				stageCleanupLimit: 1_000,
				inboundTempCleanupLimit: 1_000,
				deleteOrphanObjects: false,
				leaseMs: 55_000,
				lockTimeoutMs: 2_000,
			}),
		);

		resolveRun?.();
		await Promise.resolve();
		await Promise.resolve();
		await scheduler.onModuleDestroy();
	});

	it('실패한 실행을 정리하고 다음 interval에서 다시 시도한다', async () => {
		jest.useFakeTimers();
		process.env.IMAGE_RECONCILIATION_INTERVAL_MS = '1000';
		process.env.IMAGE_RECONCILIATION_BATCH_SLEEP_MS = '5000';
		const reconcile = jest
			.fn()
			.mockRejectedValueOnce(new Error('temporary failure'))
			.mockResolvedValue({ leaseAcquired: false });
		const scheduler = new ImageReconciliationScheduler({
			reconcile,
		} as unknown as ImageAssetLifecycleService);

		scheduler.onModuleInit();
		await flushPromises();
		await jest.advanceTimersByTimeAsync(1_000);

		expect(reconcile).toHaveBeenCalledTimes(2);
		await scheduler.onModuleDestroy();
	});

	it('종료 시 interval을 정리해 추가 reconciliation을 시작하지 않는다', async () => {
		jest.useFakeTimers();
		process.env.IMAGE_RECONCILIATION_INTERVAL_MS = '1000';
		const reconcile = jest.fn().mockResolvedValue({ leaseAcquired: false });
		const scheduler = new ImageReconciliationScheduler({
			reconcile,
		} as unknown as ImageAssetLifecycleService);

		scheduler.onModuleInit();
		await flushPromises();
		await scheduler.onModuleDestroy();
		await jest.advanceTimersByTimeAsync(3_000);

		expect(reconcile).toHaveBeenCalledTimes(1);
	});
});

const flushPromises = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};

const restoreEnv = (name: string, value: string | undefined) => {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
};
