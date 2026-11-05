import {
	Inject,
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@file/database';
import {
	DATABASE_RETENTION_CONFIG,
	DatabaseRetentionConfig,
} from './database-retention.config';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DatabaseRetentionResult {
	telemetryEvents: number;
	lifecycleEvents: number;
	adminAuditLogs: number;
	skipped: boolean;
}

export type RetentionTarget =
	'telemetryEvents' | 'lifecycleEvents' | 'adminAuditLogs';

@Injectable()
export class DatabaseRetentionService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(DatabaseRetentionService.name);
	private timer?: NodeJS.Timeout;
	private isRunning = false;

	constructor(
		private readonly prisma: PrismaService,
		@Inject(DATABASE_RETENTION_CONFIG)
		private readonly config: DatabaseRetentionConfig,
	) {}

	onModuleInit(): void {
		if (!this.config.enabled || this.config.intervalMs === 0) {
			return;
		}

		this.runBackgroundTask();
		this.timer = setInterval(() => {
			this.runBackgroundTask();
		}, this.config.intervalMs);
		this.timer.unref?.();
	}

	onModuleDestroy(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
	}

	async runRetentionCycle(now = new Date()): Promise<DatabaseRetentionResult> {
		if (this.isRunning) {
			return emptyResult(true);
		}

		this.isRunning = true;
		try {
			const telemetryEvents = await this.drainTarget(
				'telemetryEvents',
				new Date(now.getTime() - this.config.telemetryDays * DAY_MS),
			);
			const lifecycleEvents = await this.drainTarget(
				'lifecycleEvents',
				new Date(now.getTime() - this.config.lifecycleDays * DAY_MS),
			);
			const adminAuditLogs = await this.drainTarget(
				'adminAuditLogs',
				new Date(now.getTime() - this.config.adminAuditDays * DAY_MS),
			);
			const result = {
				telemetryEvents,
				lifecycleEvents,
				adminAuditLogs,
				skipped: false,
			};
			this.logger.log({ event: 'database_retention_completed', ...result });
			return result;
		} finally {
			this.isRunning = false;
		}
	}

	async runOnce(now = new Date()): Promise<DatabaseRetentionResult> {
		return this.runRetentionCycle(now);
	}

	private runBackgroundTask(): void {
		void this.runRetentionCycle().catch((error: unknown) => {
			this.logger.error({
				event: 'database_retention_failed',
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		});
	}

	private async drainTarget(
		target: RetentionTarget,
		cutoff: Date,
	): Promise<number> {
		if (this.retentionDays(target) === 0) {
			return 0;
		}

		let deleted = 0;
		for (let batch = 0; batch < this.config.maxBatchesPerRun; batch += 1) {
			const batchDeleted = await this.drainBatch(target, cutoff);
			deleted += batchDeleted;
			if (batchDeleted < this.config.batchSize) {
				break;
			}
			if (
				batch + 1 < this.config.maxBatchesPerRun &&
				this.config.batchSleepMs > 0
			) {
				await sleep(this.config.batchSleepMs);
			}
		}
		return deleted;
	}

	private retentionDays(target: RetentionTarget): number {
		switch (target) {
			case 'telemetryEvents':
				return this.config.telemetryDays;
			case 'lifecycleEvents':
				return this.config.lifecycleDays;
			case 'adminAuditLogs':
				return this.config.adminAuditDays;
		}
	}

	async drainBatch(target: RetentionTarget, cutoff: Date): Promise<number> {
		return this.prisma.$transaction(async (transaction) => {
			await transaction.$executeRaw(
				Prisma.sql`SELECT set_config('lock_timeout', ${`${this.config.lockTimeoutMs}ms`}, true)`,
			);
			const ids = await this.selectExpiredIds(transaction, target, cutoff);
			if (ids.length === 0) {
				return 0;
			}

			switch (target) {
				case 'telemetryEvents':
					return (
						await transaction.telemetryEvent.deleteMany({
							where: { id: { in: ids } },
						})
					).count;
				case 'lifecycleEvents':
					return (
						await transaction.imageLifecycleEvent.deleteMany({
							where: { id: { in: ids } },
						})
					).count;
				case 'adminAuditLogs':
					return (
						await transaction.adminAuditLog.deleteMany({
							where: { id: { in: ids } },
						})
					).count;
			}
		});
	}

	private async selectExpiredIds(
		transaction: Prisma.TransactionClient,
		target: RetentionTarget,
		cutoff: Date,
	): Promise<string[]> {
		let rows: Array<{ id: string }>;
		switch (target) {
			case 'telemetryEvents':
				rows = await transaction.$queryRaw<Array<{ id: string }>>(
					Prisma.sql`
						SELECT "id"
						FROM "telemetry_events"
						WHERE "occurred_at" < ${cutoff}
						ORDER BY "occurred_at" ASC, "id" ASC
						LIMIT ${this.config.batchSize}
						FOR UPDATE SKIP LOCKED
					`,
				);
				break;
			case 'lifecycleEvents':
				rows = await transaction.$queryRaw<Array<{ id: string }>>(
					Prisma.sql`
						SELECT "id"
						FROM "image_lifecycle_events"
						WHERE "occurred_at" < ${cutoff}
						ORDER BY "occurred_at" ASC, "id" ASC
						LIMIT ${this.config.batchSize}
						FOR UPDATE SKIP LOCKED
					`,
				);
				break;
			case 'adminAuditLogs':
				rows = await transaction.$queryRaw<Array<{ id: string }>>(
					Prisma.sql`
						SELECT "id"
						FROM "admin_audit_logs"
						WHERE "created_at" < ${cutoff}
						ORDER BY "created_at" ASC, "id" ASC
						LIMIT ${this.config.batchSize}
						FOR UPDATE SKIP LOCKED
					`,
				);
				break;
		}
		return rows.map(({ id }) => id);
	}
}

const emptyResult = (skipped: boolean): DatabaseRetentionResult => ({
	telemetryEvents: 0,
	lifecycleEvents: 0,
	adminAuditLogs: 0,
	skipped,
});

const sleep = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
