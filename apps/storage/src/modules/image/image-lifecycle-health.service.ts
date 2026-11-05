import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '@file/database';
import { ImageLifecycleMetricsService } from './image-lifecycle-metrics.service';

export const IMAGE_RECONCILIATION_METRICS_SOURCE = Symbol(
	'IMAGE_RECONCILIATION_METRICS_SOURCE',
);
export const IMAGE_LIFECYCLE_HEALTH_METRICS = Symbol(
	'IMAGE_LIFECYCLE_HEALTH_METRICS',
);

export interface ImageReconciliationMetricsSource {
	getMetricsSnapshot(): Promise<Record<string, unknown>>;
}

interface AssetMetricRow {
	pending: number;
	ready: number;
	deleting: number;
	deleted: number;
	failed: number;
	recentFailed: number;
	oldestActiveAgeMs: number | null;
}

interface VariantMetricRow {
	pending: number;
	ready: number;
	deleting: number;
	deleted: number;
	failed: number;
	recentFailed: number;
	oldestActiveAgeMs: number | null;
}

interface JobMetricRow {
	pending: number;
	processing: number;
	completed: number;
	failed: number;
	recentFailed: number;
	cancelled: number;
	oldestActiveAgeMs: number | null;
}

@Injectable()
export class ImageLifecycleHealthService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly runtimeMetrics: ImageLifecycleMetricsService,
		@Optional()
		@Inject(IMAGE_RECONCILIATION_METRICS_SOURCE)
		private readonly reconciliation?: ImageReconciliationMetricsSource,
	) {}

	async getMetrics() {
		try {
			const [[assets], [variants], [jobs], reconciliation] = await Promise.all([
				this.prisma.$queryRaw<AssetMetricRow[]>`
					SELECT
						COUNT(*) FILTER (WHERE status = 'Pending')::int AS pending,
						COUNT(*) FILTER (WHERE status = 'Ready')::int AS ready,
						COUNT(*) FILTER (WHERE status = 'Deleting')::int AS deleting,
						COUNT(*) FILTER (WHERE status = 'Deleted')::int AS deleted,
						COUNT(*) FILTER (WHERE status = 'Failed')::int AS failed,
						COUNT(*) FILTER (WHERE status = 'Failed' AND updated_at >= NOW() - INTERVAL '5 minutes')::int AS "recentFailed",
						COALESCE(
							EXTRACT(EPOCH FROM (NOW() - MIN(
								CASE
									WHEN status = 'Pending' THEN created_at
									WHEN status = 'Deleting' THEN COALESCE(deleting_at, updated_at)
								END
							))) * 1000,
							NULL
						)::double precision AS "oldestActiveAgeMs"
					FROM image_assets
				`,
				this.prisma.$queryRaw<VariantMetricRow[]>`
					SELECT
						COUNT(*) FILTER (WHERE status = 'Pending')::int AS pending,
						COUNT(*) FILTER (WHERE status = 'Ready')::int AS ready,
						COUNT(*) FILTER (WHERE status = 'Deleting')::int AS deleting,
						COUNT(*) FILTER (WHERE status = 'Deleted')::int AS deleted,
						COUNT(*) FILTER (WHERE status = 'Failed')::int AS failed,
						COUNT(*) FILTER (WHERE status = 'Failed' AND updated_at >= NOW() - INTERVAL '5 minutes')::int AS "recentFailed",
						COALESCE(
							EXTRACT(EPOCH FROM (NOW() - MIN(
								CASE
									WHEN status = 'Pending' THEN created_at
									WHEN status = 'Deleting' THEN COALESCE(deleting_at, updated_at)
								END
							))) * 1000,
							NULL
						)::double precision AS "oldestActiveAgeMs"
					FROM image_variants
				`,
				this.prisma.$queryRaw<JobMetricRow[]>`
					SELECT
						COUNT(*) FILTER (WHERE status = 'Pending')::int AS pending,
						COUNT(*) FILTER (WHERE status = 'Processing')::int AS processing,
						COUNT(*) FILTER (WHERE status = 'Completed')::int AS completed,
						COUNT(*) FILTER (WHERE status = 'Failed')::int AS failed,
						COUNT(*) FILTER (WHERE status = 'Failed' AND updated_at >= NOW() - INTERVAL '5 minutes')::int AS "recentFailed",
						COUNT(*) FILTER (WHERE status = 'Cancelled')::int AS cancelled,
						COALESCE(
							EXTRACT(EPOCH FROM (NOW() - (MIN(created_at) FILTER (WHERE status IN ('Pending', 'Processing'))))) * 1000,
							NULL
						)::double precision AS "oldestActiveAgeMs"
					FROM image_variant_jobs
				`,
				this.reconciliation?.getMetricsSnapshot() ??
					Promise.resolve({ supported: false }),
			]);
			const runtime = this.runtimeMetrics.getMetrics();
			const thresholds = readThresholds();
			const reconciliationReady = isReconciliationReady(reconciliation);
			const ready =
				assets.recentFailed <= thresholds.assetFailed &&
				variants.recentFailed <= thresholds.variantFailed &&
				jobs.recentFailed <= thresholds.jobFailed &&
				(assets.oldestActiveAgeMs ?? 0) <= thresholds.activeStateLagMs &&
				(variants.oldestActiveAgeMs ?? 0) <= thresholds.activeStateLagMs &&
				(jobs.oldestActiveAgeMs ?? 0) <= thresholds.variantLagMs &&
				runtime.variantJobs.ready &&
				reconciliationReady;

			return {
				supported: true,
				ready,
				thresholds,
				assets,
				variants,
				jobs,
				runtime,
				reconciliation: presentReconciliationMetrics(reconciliation),
			};
		} catch (error) {
			return {
				supported: false,
				ready: false,
				error: error instanceof Error ? error.message : String(error),
				runtime: this.runtimeMetrics.getMetrics(),
				reconciliation: { supported: false },
			};
		}
	}
}

function readThresholds() {
	return {
		activeStateLagMs: readNonNegative(
			process.env.IMAGE_LIFECYCLE_READINESS_MAX_ACTIVE_STATE_AGE_MS,
			5 * 60_000,
		),
		variantLagMs: readNonNegative(
			process.env.IMAGE_VARIANT_READINESS_MAX_LAG_MS,
			5 * 60_000,
		),
		assetFailed: readNonNegative(
			process.env.IMAGE_ASSET_FAILED_READINESS_THRESHOLD,
			0,
		),
		variantFailed: readNonNegative(
			process.env.IMAGE_VARIANT_FAILED_READINESS_THRESHOLD,
			0,
		),
		jobFailed: readNonNegative(
			process.env.IMAGE_VARIANT_JOB_FAILED_READINESS_THRESHOLD,
			0,
		),
	};
}

function readNonNegative(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isReconciliationReady(value: Record<string, unknown>): boolean {
	if (process.env.IMAGE_RECONCILIATION_ENABLED === 'false') return true;
	if (value.supported !== true || value.lastError) return false;
	const lastRunAt =
		typeof value.lastRunAt === 'string' ? Date.parse(value.lastRunAt) : NaN;
	if (!Number.isFinite(lastRunAt)) return false;
	const maxStalenessMs = readNonNegative(
		process.env.IMAGE_RECONCILIATION_READINESS_MAX_STALENESS_MS,
		5 * 60_000,
	);
	return Date.now() - lastRunAt <= maxStalenessMs;
}

function presentReconciliationMetrics(value: Record<string, unknown>) {
	if (
		process.env.IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED !== 'true'
	) {
		return value;
	}
	return {
		...value,
		supported: false,
		orphanCount: null,
		transition: {
			imageLifecycleSupported: value.supported,
			imageLifecycleOrphanCount: value.orphanCount,
			legacyCompatEnabled: true,
		},
	};
}
