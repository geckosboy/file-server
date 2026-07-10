import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit,
} from '@nestjs/common';
import { hostname } from 'os';
import { ImageAssetLifecycleService } from './image-asset-lifecycle.service';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 4 * 60_000;
const DEFAULT_LEASE_MS = 55_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_SCAN_LIMIT = 1_000;

export interface ImageReconciliationConfig {
	enabled: boolean;
	intervalMs: number;
	batchSleepMs: number;
	staleAfterMs: number;
	leaseMs: number;
	lockTimeoutMs: number;
	batchSize: number;
	objectScanLimit: number;
	stageCleanupLimit: number;
	inboundTempCleanupLimit: number;
	orphanDeleteEnabled: boolean;
}

@Injectable()
export class ImageReconciliationScheduler
	implements OnModuleInit, OnModuleDestroy
{
	private readonly logger = new Logger(ImageReconciliationScheduler.name);
	private readonly owner = `${hostname()}:${process.pid}`;
	private timer?: NodeJS.Timeout;
	private running?: Promise<void>;

	constructor(private readonly lifecycle: ImageAssetLifecycleService) {}

	onModuleInit() {
		const config = readImageReconciliationConfig();
		if (!config.enabled) {
			return;
		}
		this.run(config);
		this.timer = setInterval(() => this.run(config), config.batchSleepMs);
		this.timer.unref?.();
	}

	async onModuleDestroy() {
		if (this.timer) {
			clearInterval(this.timer);
		}
		await this.running;
	}

	private run(config: ImageReconciliationConfig) {
		if (this.running) {
			return;
		}
		const now = new Date();
		const staleBefore = new Date(now.getTime() - config.staleAfterMs);
		this.running = this.lifecycle
			.reconcile({
				updatedBefore: staleBefore,
				orphanedBefore: staleBefore,
				limit: config.batchSize,
				objectScanLimit: config.objectScanLimit,
				stageCleanupLimit: config.stageCleanupLimit,
				inboundTempCleanupLimit: config.inboundTempCleanupLimit,
				deleteOrphanObjects: config.orphanDeleteEnabled,
				leaseOwner: this.owner,
				leaseMs: config.leaseMs,
				lockTimeoutMs: config.lockTimeoutMs,
				now,
			})
			.then((report) => {
				if (report.leaseAcquired) {
					this.logger.log(`image reconciliation ${JSON.stringify(report)}`);
				}
			})
			.catch((error: unknown) => {
				this.logger.error(
					`image reconciliation failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			})
			.finally(() => {
				this.running = undefined;
			});
	}
}

export const readImageReconciliationConfig = (
	env: NodeJS.ProcessEnv = process.env,
): ImageReconciliationConfig => ({
	enabled: env.IMAGE_RECONCILIATION_ENABLED !== 'false',
	intervalMs: readPositiveInteger(
		env.IMAGE_RECONCILIATION_INTERVAL_MS,
		DEFAULT_INTERVAL_MS,
	),
	batchSleepMs: readPositiveInteger(
		env.IMAGE_RECONCILIATION_BATCH_SLEEP_MS ??
			env.IMAGE_RECONCILIATION_INTERVAL_MS,
		DEFAULT_INTERVAL_MS,
	),
	staleAfterMs: readPositiveInteger(
		env.IMAGE_RECONCILIATION_STALE_AFTER_MS,
		DEFAULT_STALE_AFTER_MS,
	),
	leaseMs: readPositiveInteger(
		env.IMAGE_RECONCILIATION_LEASE_MS,
		DEFAULT_LEASE_MS,
	),
	lockTimeoutMs: readPositiveInteger(
		env.IMAGE_RECONCILIATION_LOCK_TIMEOUT_MS,
		DEFAULT_LOCK_TIMEOUT_MS,
	),
	batchSize: readPositiveInteger(
		env.IMAGE_RECONCILIATION_BATCH_SIZE,
		DEFAULT_BATCH_SIZE,
	),
	objectScanLimit: readPositiveInteger(
		env.IMAGE_RECONCILIATION_OBJECT_SCAN_LIMIT,
		DEFAULT_SCAN_LIMIT,
	),
	stageCleanupLimit: readPositiveInteger(
		env.IMAGE_RECONCILIATION_STAGE_CLEANUP_LIMIT,
		DEFAULT_SCAN_LIMIT,
	),
	inboundTempCleanupLimit: readPositiveInteger(
		env.IMAGE_RECONCILIATION_INBOUND_TEMP_CLEANUP_LIMIT,
		DEFAULT_SCAN_LIMIT,
	),
	orphanDeleteEnabled:
		env.IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED === 'true',
});

const readPositiveInteger = (value: string | undefined, fallback: number) => {
	const parsed = value === undefined ? fallback : Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
