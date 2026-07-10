import { Injectable } from '@nestjs/common';
import {
	ImageAsset,
	ImageAssetState,
	ImageVariant,
	ImageVariantJobState,
	ImageVariantState,
	Prisma,
} from '@prisma/client';
import {
	ImageVariantJobFormat,
	createImageVariantJobEvent,
	createImageVariantJobKey,
	type ImageVariantJobEvent,
} from '@file/telemetry-contracts';
import { createBoundedImageVariantName } from '@file/image-contracts';
import { randomUUID } from 'crypto';
import { PrismaService } from './prisma.service';

export type { ImageVariantJobEvent } from '@file/telemetry-contracts';

const MAX_ERROR_LENGTH = 1_000;
const MAX_STATE_TRANSITION_ATTEMPTS = 4;
const TRACKED_STORAGE_KEY_QUERY_BATCH_SIZE = 1_000;
const DEFAULT_RECONCILIATION_LEASE_NAME = 'image-asset-reconciliation';
const DEFAULT_RECONCILIATION_LOCK_TIMEOUT_MS = 1_000;
const RECONCILIATION_METRIC_ID = 'image-asset-reconciliation';

class VariantJobFencedError extends Error {}

export type AssetTransactionWork = (
	transaction: Prisma.TransactionClient,
	asset: ImageAsset,
) => Promise<void>;

export type DeleteTransactionWork = (
	transaction: Prisma.TransactionClient,
	asset: ImageAsset,
	deleteEventId: string,
) => Promise<void>;

export type VariantTransactionWork = (
	transaction: Prisma.TransactionClient,
	variant: ImageVariant,
) => Promise<void>;

export interface CreatePendingUploadInput {
	clientServiceId: string;
	idempotencyKey: string;
	externalImageId?: number;
	logicalPath: string;
	name: string;
	originalName: string;
	storageKey: string;
	contentType: string;
	inputBytes?: number;
}

export interface CompleteUploadInput {
	assetId: string;
	sourceEventId: string;
	bytes: number;
	checksum: string;
	format: string;
	width?: number;
	height?: number;
}

export interface RepairReadyAssetInput {
	assetId: string;
	bytes: number;
	checksum: string;
	format: string;
	width?: number;
	height?: number;
}

export interface ImageVariantSpec {
	width?: number;
	height?: number;
	format: string;
}

export interface ReadyImageAssetForVariants {
	assetId: string;
	clientServiceId: string;
	logicalPath: string;
	name: string;
	storageKey: string;
	sourceChecksum: string;
	variants: ImageVariantSpec[];
}

export interface CompleteVariantJobInput {
	name: string;
	storageKey: string;
	inputBytes: number;
	outputBytes: number;
	checksum: string;
}

export interface ImageReconciliationResultMetric {
	orphanCount: number;
	repairedCount: number;
	failedCount: number;
	oldestPendingAgeMs: number | null;
	oldestDeletingAgeMs: number | null;
	durationMs: number;
}

export type ClaimVariantJobResult =
	| { result: 'claimed'; event: ImageVariantJobEvent }
	| { result: 'duplicate'; event: ImageVariantJobEvent }
	| { result: 'discarded'; event: ImageVariantJobEvent }
	| { result: 'unavailable' };

@Injectable()
export class ImageAssetMetadataRepository {
	constructor(private readonly prisma: PrismaService) {}

	isWriteEnabled() {
		return process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED !== 'false';
	}

	isDualReadEnabled() {
		return process.env.IMAGE_ASSET_DUAL_READ_ENABLED !== 'false';
	}

	async createPendingUpload(
		input: CreatePendingUploadInput,
	): Promise<ImageAsset | null> {
		if (!this.isWriteEnabled()) return null;
		const asset = await this.prisma.imageAsset.upsert({
			where: {
				clientServiceId_idempotencyKey: {
					clientServiceId: input.clientServiceId,
					idempotencyKey: input.idempotencyKey,
				},
			},
			create: {
				clientServiceId: input.clientServiceId,
				idempotencyKey: input.idempotencyKey,
				externalImageId: input.externalImageId,
				logicalPath: input.logicalPath,
				name: input.name,
				originalName: input.originalName,
				storageKey: input.storageKey,
				contentType: input.contentType,
				inputBytes: input.inputBytes,
				status: ImageAssetState.Pending,
			},
			update: {},
		});
		assertSameUploadIdentity(asset, input);
		return asset;
	}

	async completeUpload(
		input: CompleteUploadInput,
		enqueueOutbox?: AssetTransactionWork,
	): Promise<ImageAsset> {
		return this.prisma.$transaction(async (transaction) => {
			if (!input.sourceEventId.trim()) {
				throw new Error('sourceEventId is required');
			}
			for (
				let attempt = 0;
				attempt < MAX_STATE_TRANSITION_ATTEMPTS;
				attempt += 1
			) {
				const existing = await transaction.imageAsset.findUniqueOrThrow({
					where: { assetId: input.assetId },
				});
				if (existing.status === ImageAssetState.Ready) return existing;
				assertSourceEventIdentity(existing, input.sourceEventId);
				if (
					existing.status === ImageAssetState.Deleting ||
					existing.status === ImageAssetState.Deleted
				) {
					throw new Error(`asset ${input.assetId} cannot transition to Ready`);
				}

				const transitioned = await transaction.imageAsset.updateMany({
					where: {
						assetId: input.assetId,
						status: existing.status,
						updatedAt: existing.updatedAt,
						sourceEventId: existing.sourceEventId,
					},
					data: {
						status: ImageAssetState.Ready,
						sourceEventId: input.sourceEventId,
						bytes: input.bytes,
						checksum: input.checksum,
						format: input.format,
						width: input.width,
						height: input.height,
						readyAt: existing.readyAt ?? new Date(),
						failedAt: null,
						failureReason: null,
					},
				});
				if (transitioned.count !== 1) continue;

				const asset = await transaction.imageAsset.findUniqueOrThrow({
					where: { assetId: input.assetId },
				});
				await enqueueOutbox?.(transaction, asset);
				return asset;
			}
			throw new Error(`asset ${input.assetId} Ready transition was contended`);
		});
	}

	findAssetById(assetId: string) {
		return this.prisma.imageAsset.findUnique({ where: { assetId } });
	}

	findAssetForDelete(input: {
		clientServiceId: string;
		logicalPath: string;
		name: string;
	}) {
		return this.prisma.imageAsset.findUnique({
			where: { clientServiceId_logicalPath_name: input },
			include: { variants: true },
		});
	}

	async repairReadyAssetMetadata(
		input: RepairReadyAssetInput,
		ensureDerivedState?: AssetTransactionWork,
	): Promise<ImageAsset> {
		return this.prisma.$transaction(async (transaction) => {
			const existing = await transaction.imageAsset.findUniqueOrThrow({
				where: { assetId: input.assetId },
			});
			if (existing.status !== ImageAssetState.Ready) {
				throw new Error(`asset ${input.assetId} is not Ready`);
			}
			if (existing.checksum && existing.checksum !== input.checksum) {
				throw new Error(`ready asset ${input.assetId} source checksum changed`);
			}
			const asset = await transaction.imageAsset.update({
				where: { assetId: input.assetId },
				data: {
					...(existing.checksum
						? {}
						: {
								bytes: input.bytes,
								checksum: input.checksum,
								format: input.format,
								width: input.width,
								height: input.height,
							}),
					lastReconciledAt: new Date(),
				},
			});
			await ensureDerivedState?.(transaction, asset);
			return asset;
		});
	}

	async getVariantStatus(assetId: string) {
		const variants = await this.prisma.imageVariant.findMany({
			where: { assetId, status: { not: ImageVariantState.Deleted } },
			select: { status: true },
			take: 1_000,
		});
		if (variants.length === 0) return 'NotConfigured' as const;
		if (variants.some(({ status }) => status === ImageVariantState.Failed)) {
			return 'Failed' as const;
		}
		if (variants.every(({ status }) => status === ImageVariantState.Ready)) {
			return 'Ready' as const;
		}
		return 'Pending' as const;
	}

	async failAsset(
		assetId: string,
		error: unknown,
		enqueueOutbox?: AssetTransactionWork,
	) {
		return this.prisma.$transaction(async (transaction) => {
			const existing = await transaction.imageAsset.findUniqueOrThrow({
				where: { assetId },
			});
			if (
				existing.status === ImageAssetState.Deleting ||
				existing.status === ImageAssetState.Deleted
			) {
				return existing;
			}
			const expectedStates = expectedFailureSourceStates(error, enqueueOutbox);
			if (!expectedStates.includes(existing.status)) return existing;
			const failed = await transaction.imageAsset.updateMany({
				where: {
					assetId,
					status: existing.status,
					updatedAt: existing.updatedAt,
				},
				data: {
					status: ImageAssetState.Failed,
					failedAt: existing.failedAt ?? new Date(),
					failureReason: errorMessage(error),
				},
			});
			if (failed.count !== 1) {
				return transaction.imageAsset.findUniqueOrThrow({ where: { assetId } });
			}
			const asset = await transaction.imageAsset.findUniqueOrThrow({
				where: { assetId },
			});
			await enqueueOutbox?.(transaction, asset);
			return asset;
		});
	}

	async beginDelete(
		assetId: string,
		requestedDeleteEventId: string = randomUUID(),
	) {
		return this.prisma.$transaction(async (transaction) => {
			for (
				let attempt = 0;
				attempt < MAX_STATE_TRANSITION_ATTEMPTS;
				attempt += 1
			) {
				const asset = await transaction.imageAsset.findUnique({
					where: { assetId },
					include: { variants: true },
				});
				if (!asset || asset.status === ImageAssetState.Deleted) return asset;
				if (asset.status === ImageAssetState.Deleting && asset.deleteEventId) {
					return asset;
				}
				if (asset.status === ImageAssetState.Pending) {
					throw new Error(`asset ${assetId} cannot be deleted while Pending`);
				}
				if (
					asset.status !== ImageAssetState.Ready &&
					asset.status !== ImageAssetState.Failed
				) {
					throw new Error(
						`asset ${assetId} cannot transition from ${asset.status} to Deleting`,
					);
				}
				const deletingAt = asset.deletingAt ?? new Date();
				const deleteEventId = asset.deleteEventId ?? requestedDeleteEventId;
				const transitioned = await transaction.imageAsset.updateMany({
					where: {
						assetId,
						status: asset.status,
						updatedAt: asset.updatedAt,
						deleteEventId: asset.deleteEventId,
					},
					data: {
						status: ImageAssetState.Deleting,
						deletingAt,
						deleteEventId,
						cacheVersion: { increment: 1 },
					},
				});
				if (transitioned.count !== 1) continue;
				await transaction.imageVariant.updateMany({
					where: {
						assetId,
						status: { not: ImageVariantState.Deleted },
					},
					data: { status: ImageVariantState.Deleting, deletingAt },
				});
				return transaction.imageAsset.findUniqueOrThrow({
					where: { assetId },
					include: { variants: true },
				});
			}
			throw new Error(`asset ${assetId} delete transition was contended`);
		});
	}

	async completeDelete(assetId: string, enqueueOutbox?: DeleteTransactionWork) {
		return this.prisma.$transaction(async (transaction) => {
			const existing = await transaction.imageAsset.findUniqueOrThrow({
				where: { assetId },
				select: { deleteEventId: true },
			});
			const deleteEventId = existing.deleteEventId ?? randomUUID();
			const deletedAt = new Date();
			await transaction.imageVariant.updateMany({
				where: { assetId },
				data: {
					status: ImageVariantState.Deleted,
					deletedAt,
					failureReason: null,
				},
			});
			await transaction.imageVariantJob.updateMany({
				where: {
					assetId,
					status: { not: ImageVariantJobState.Completed },
				},
				data: {
					status: ImageVariantJobState.Cancelled,
					leaseOwner: null,
					leaseExpiresAt: null,
				},
			});
			const asset = await transaction.imageAsset.update({
				where: { assetId },
				data: {
					status: ImageAssetState.Deleted,
					deleteEventId,
					deletedAt,
					failureReason: null,
				},
			});
			await enqueueOutbox?.(transaction, asset, deleteEventId);
			return asset;
		});
	}

	recordDeleteFailure(
		assetId: string,
		error: unknown,
		enqueueOutbox?: DeleteTransactionWork,
	) {
		return this.prisma.$transaction(async (transaction) => {
			const asset = await transaction.imageAsset.findUniqueOrThrow({
				where: { assetId },
			});
			if (asset.status !== ImageAssetState.Deleting) return asset;
			const deleteEventId = asset.deleteEventId ?? randomUUID();
			const updated = await transaction.imageAsset.update({
				where: { assetId },
				data: {
					deleteEventId,
					failedAt: new Date(),
					failureReason: errorMessage(error),
				},
			});
			await enqueueOutbox?.(transaction, updated, deleteEventId);
			return updated;
		});
	}

	async listReconciliationCandidates(updatedBefore: Date, limit: number) {
		const take = boundedLimit(limit);
		const urgent = await this.prisma.imageAsset.findMany({
			where: {
				status: {
					in: [ImageAssetState.Pending, ImageAssetState.Deleting],
				},
				updatedAt: { lte: updatedBefore },
			},
			include: { variants: true },
			orderBy: [{ updatedAt: 'asc' }, { assetId: 'asc' }],
			take,
		});
		if (urgent.length >= take) return urgent;
		const unreconciled = await this.prisma.imageAsset.findMany({
			where: {
				status: ImageAssetState.Ready,
				lastReconciledAt: null,
				updatedAt: { lte: updatedBefore },
			},
			include: { variants: true },
			orderBy: [{ updatedAt: 'asc' }, { assetId: 'asc' }],
			take: take - urgent.length,
		});
		if (urgent.length + unreconciled.length >= take) {
			return [...urgent, ...unreconciled];
		}
		const reconciled = await this.prisma.imageAsset.findMany({
			where: {
				status: ImageAssetState.Ready,
				lastReconciledAt: { lte: updatedBefore },
			},
			include: { variants: true },
			orderBy: [{ lastReconciledAt: 'asc' }, { assetId: 'asc' }],
			take: take - urgent.length - unreconciled.length,
		});
		return [...urgent, ...unreconciled, ...reconciled];
	}

	async listTrackedStorageKeys(storageKeys: string[]) {
		const uniqueKeys = [...new Set(storageKeys)];
		if (!uniqueKeys.length) return [];
		const tracked = new Set<string>();
		for (
			let offset = 0;
			offset < uniqueKeys.length;
			offset += TRACKED_STORAGE_KEY_QUERY_BATCH_SIZE
		) {
			const batch = uniqueKeys.slice(
				offset,
				offset + TRACKED_STORAGE_KEY_QUERY_BATCH_SIZE,
			);
			const [assets, variants] = await Promise.all([
				this.prisma.imageAsset.findMany({
					where: {
						storageKey: { in: batch },
						status: { not: ImageAssetState.Deleted },
					},
					select: { storageKey: true },
				}),
				this.prisma.imageVariant.findMany({
					where: {
						storageKey: { in: batch },
						status: { not: ImageVariantState.Deleted },
					},
					select: { storageKey: true },
				}),
			]);
			for (const { storageKey } of [...assets, ...variants]) {
				tracked.add(storageKey);
			}
		}
		return [...tracked];
	}

	async listDeletedStorageKeys(storageKeys: string[]) {
		const uniqueKeys = [...new Set(storageKeys)];
		if (!uniqueKeys.length) return [];
		const deleted = new Set<string>();
		for (
			let offset = 0;
			offset < uniqueKeys.length;
			offset += TRACKED_STORAGE_KEY_QUERY_BATCH_SIZE
		) {
			const batch = uniqueKeys.slice(
				offset,
				offset + TRACKED_STORAGE_KEY_QUERY_BATCH_SIZE,
			);
			const [assets, variants] = await Promise.all([
				this.prisma.imageAsset.findMany({
					where: {
						storageKey: { in: batch },
						status: ImageAssetState.Deleted,
					},
					select: { storageKey: true },
				}),
				this.prisma.imageVariant.findMany({
					where: {
						storageKey: { in: batch },
						status: ImageVariantState.Deleted,
					},
					select: { storageKey: true },
				}),
			]);
			for (const { storageKey } of [...assets, ...variants]) {
				deleted.add(storageKey);
			}
		}
		return [...deleted];
	}

	async listRecentlyDeletedStorageKeys(limit: number) {
		const take = boundedLimit(limit);
		const [assets, variants] = await Promise.all([
			this.prisma.imageAsset.findMany({
				where: { status: ImageAssetState.Deleted },
				orderBy: [{ deletedAt: 'desc' }, { assetId: 'desc' }],
				take,
				select: { storageKey: true },
			}),
			this.prisma.imageVariant.findMany({
				where: { status: ImageVariantState.Deleted },
				orderBy: [{ deletedAt: 'desc' }, { variantId: 'desc' }],
				take,
				select: { storageKey: true },
			}),
		]);
		return [
			...new Set([...assets, ...variants].map(({ storageKey }) => storageKey)),
		];
	}

	async tryAcquireReconciliationLease(
		owner: string,
		leaseMs: number,
		lockTimeoutMs: number,
		leaseName = DEFAULT_RECONCILIATION_LEASE_NAME,
	): Promise<string | null> {
		const token = randomUUID();
		const expiresAt = new Date(
			Date.now() + positiveInteger(leaseMs, 'leaseMs'),
		);
		return this.withLeaseLockTimeout(lockTimeoutMs, async (transaction) => {
			const rows = await transaction.$queryRaw<
				Array<{ token: string }>
			>(Prisma.sql`
				INSERT INTO "image_reconciliation_leases" (
					"lease_name", "owner", "token", "expires_at", "created_at", "updated_at"
				)
				VALUES (${leaseName}, ${owner}, ${token}, ${expiresAt}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
				ON CONFLICT ("lease_name") DO UPDATE SET
					"owner" = EXCLUDED."owner",
					"token" = EXCLUDED."token",
					"expires_at" = EXCLUDED."expires_at",
					"updated_at" = CURRENT_TIMESTAMP
				WHERE "image_reconciliation_leases"."expires_at" <= CURRENT_TIMESTAMP
					OR "image_reconciliation_leases"."owner" = ${owner}
				RETURNING "token"
			`);
			return rows[0]?.token ?? null;
		});
	}

	async renewReconciliationLease(
		owner: string,
		token: string,
		leaseMs: number,
		lockTimeoutMs = DEFAULT_RECONCILIATION_LOCK_TIMEOUT_MS,
	) {
		return this.withLeaseLockTimeout(lockTimeoutMs, (transaction) =>
			transaction.imageReconciliationLease.updateMany({
				where: { owner, token, expiresAt: { gt: new Date() } },
				data: {
					expiresAt: new Date(Date.now() + positiveInteger(leaseMs, 'leaseMs')),
				},
			}),
		);
	}

	async releaseReconciliationLease(owner: string, token: string) {
		await this.prisma.imageReconciliationLease.deleteMany({
			where: { owner, token },
		});
	}

	async getReconciliationBacklogMetrics() {
		const [pending, deleting, failed, failedVariants] = await Promise.all([
			this.prisma.imageAsset.aggregate({
				where: { status: ImageAssetState.Pending },
				_count: true,
				_min: { createdAt: true },
			}),
			this.prisma.imageAsset.aggregate({
				where: { status: ImageAssetState.Deleting },
				_count: true,
				_min: { deletingAt: true },
			}),
			this.prisma.imageAsset.count({
				where: { status: ImageAssetState.Failed },
			}),
			this.prisma.imageVariant.count({
				where: { status: ImageVariantState.Failed },
			}),
		]);
		return {
			supported: true as const,
			orphanCount: pending._count + deleting._count + failed + failedVariants,
			pendingCount: pending._count,
			deletingCount: deleting._count,
			failedCount: failed,
			failedVariantCount: failedVariants,
			oldestPendingAt: pending._min.createdAt ?? null,
			oldestDeletingAt: deleting._min.deletingAt ?? null,
		};
	}

	async recordReconciliationResult(input: ImageReconciliationResultMetric) {
		const now = new Date();
		return this.prisma.imageReconciliationMetric.upsert({
			where: { id: RECONCILIATION_METRIC_ID },
			create: {
				id: RECONCILIATION_METRIC_ID,
				...input,
				lastRunAt: now,
				lastSuccessAt: now,
			},
			update: {
				orphanCount: input.orphanCount,
				repairedCount: { increment: input.repairedCount },
				failedCount: { increment: input.failedCount },
				oldestPendingAgeMs: input.oldestPendingAgeMs,
				oldestDeletingAgeMs: input.oldestDeletingAgeMs,
				durationMs: input.durationMs,
				lastRunAt: now,
				lastSuccessAt: now,
				lastError: null,
			},
		});
	}

	recordReconciliationFailure(error: unknown, durationMs: number) {
		const now = new Date();
		return this.prisma.imageReconciliationMetric.upsert({
			where: { id: RECONCILIATION_METRIC_ID },
			create: {
				id: RECONCILIATION_METRIC_ID,
				failedCount: 1,
				durationMs,
				lastRunAt: now,
				lastError: errorMessage(error),
			},
			update: {
				failedCount: { increment: 1 },
				durationMs,
				lastRunAt: now,
				lastError: errorMessage(error),
			},
		});
	}

	async getMetricsSnapshot() {
		const metric = await this.prisma.imageReconciliationMetric.findUnique({
			where: { id: RECONCILIATION_METRIC_ID },
		});
		return {
			supported: true as const,
			orphanCount: metric?.orphanCount ?? 0,
			repairedCount: metric?.repairedCount ?? 0,
			failedCount: metric?.failedCount ?? 0,
			oldestPendingAgeMs: metric?.oldestPendingAgeMs ?? null,
			oldestDeletingAgeMs: metric?.oldestDeletingAgeMs ?? null,
			durationMs: metric?.durationMs ?? 0,
			lastRunAt: metric?.lastRunAt?.toISOString() ?? null,
			lastSuccessAt: metric?.lastSuccessAt?.toISOString() ?? null,
			lastError: metric?.lastError ?? null,
		};
	}

	async createPendingJobs(
		input: ReadyImageAssetForVariants,
	): Promise<ImageVariantJobEvent[]> {
		if (!this.isWriteEnabled()) return [];
		return this.prisma.$transaction((transaction) =>
			this.createPendingJobsWithinTransaction(transaction, input),
		);
	}

	async createPendingJobsWithinTransaction(
		transaction: Prisma.TransactionClient,
		input: ReadyImageAssetForVariants,
	): Promise<ImageVariantJobEvent[]> {
		const asset = await transaction.imageAsset.findUnique({
			where: { assetId: input.assetId },
			select: { status: true, checksum: true },
		});
		if (
			!asset ||
			asset.status !== ImageAssetState.Ready ||
			asset.checksum !== input.sourceChecksum
		) {
			return [];
		}
		const specs = normalizeVariantSpecs(input);
		if (specs.length === 0) return [];
		await transaction.imageVariant.createMany({
			data: specs.map((spec) => ({
				assetId: input.assetId,
				specKey: spec.specKey,
				storageKey: spec.storageKey,
				width: spec.width,
				height: spec.height,
				format: spec.format,
				sourceChecksum: input.sourceChecksum,
				status: ImageVariantState.Pending,
			})),
			skipDuplicates: true,
		});
		const variants = await transaction.imageVariant.findMany({
			where: {
				assetId: input.assetId,
				specKey: { in: specs.map(({ specKey }) => specKey) },
			},
			orderBy: { specKey: 'asc' },
		});
		const jobs = variants.map((variant) => ({
			variant,
			jobKey: createImageVariantJobKey({
				assetId: input.assetId,
				sourceChecksum: input.sourceChecksum,
				width: variant.width ?? undefined,
				height: variant.height ?? undefined,
				format: normalizeFormat(variant.format),
			}),
		}));
		await transaction.imageVariantJob.createMany({
			data: jobs.map(({ jobKey, variant }) => ({
				assetId: input.assetId,
				variantId: variant.variantId,
				jobKey,
				status: ImageVariantJobState.Pending,
			})),
			skipDuplicates: true,
		});
		const publishable = await transaction.imageVariantJob.findMany({
			where: {
				jobKey: { in: jobs.map(({ jobKey }) => jobKey) },
				publishedAt: null,
				status: {
					in: [ImageVariantJobState.Pending, ImageVariantJobState.Failed],
				},
			},
			select: { jobKey: true, variantId: true, createdAt: true },
		});
		const variantById = new Map(
			variants.map((variant) => [variant.variantId, variant]),
		);
		return publishable.flatMap((job) => {
			const variant = variantById.get(job.variantId);
			return variant
				? [toVariantJobEvent(input, variant, job.jobKey, job.createdAt)]
				: [];
		});
	}

	async listPublishableJobs(limit: number): Promise<ImageVariantJobEvent[]> {
		const rows = await this.prisma.imageVariantJob.findMany({
			where: {
				publishedAt: null,
				nextPublishAt: { lte: new Date() },
				status: {
					in: [ImageVariantJobState.Pending, ImageVariantJobState.Failed],
				},
				asset: { status: ImageAssetState.Ready },
			},
			include: { asset: true, variant: true },
			orderBy: [{ nextPublishAt: 'asc' }, { jobId: 'asc' }],
			take: boundedLimit(limit),
		});
		return rows.map((row) =>
			toVariantJobEvent(
				{
					assetId: row.assetId,
					clientServiceId: row.asset.clientServiceId,
					logicalPath: row.asset.logicalPath,
					name: row.asset.name,
					storageKey: row.asset.storageKey,
					sourceChecksum: row.variant.sourceChecksum,
					variants: [],
				},
				row.variant,
				row.jobKey,
				row.createdAt,
			),
		);
	}

	recordPublished(job: string | Pick<ImageVariantJobEvent, 'jobKey'>) {
		return this.prisma.imageVariantJob.update({
			where: { jobKey: resolveJobKey(job) },
			data: {
				publishedAt: new Date(),
				publishLastError: null,
			},
		});
	}

	recordPublishFailure(
		job: string | Pick<ImageVariantJobEvent, 'jobKey'>,
		error: unknown,
	) {
		return this.prisma.imageVariantJob.update({
			where: { jobKey: resolveJobKey(job) },
			data: {
				publishAttempts: { increment: 1 },
				nextPublishAt: new Date(Date.now() + 1_000),
				publishLastError: errorMessage(error),
			},
		});
	}

	async claimJob(
		event: ImageVariantJobEvent,
		owner = 'resize-worker',
		leaseMs = 30_000,
	): Promise<ClaimVariantJobResult> {
		const job = await this.prisma.imageVariantJob.findUnique({
			where: { jobKey: event.jobKey },
			include: { asset: true, variant: true },
		});
		if (!job) {
			return { result: 'unavailable' };
		}
		if (
			job.status === ImageVariantJobState.Completed ||
			job.variant.status === ImageVariantState.Ready
		) {
			return { result: 'duplicate', event };
		}
		if (
			job.status === ImageVariantJobState.Cancelled ||
			job.variant.status === ImageVariantState.Deleting ||
			job.variant.status === ImageVariantState.Deleted ||
			job.asset.status === ImageAssetState.Deleting ||
			job.asset.status === ImageAssetState.Deleted ||
			(job.status === ImageVariantJobState.Failed &&
				job.attempts >= readVariantJobMaxAttempts())
		) {
			return { result: 'discarded', event };
		}
		if (job.asset.status !== ImageAssetState.Ready) {
			return { result: 'unavailable' };
		}

		const now = new Date();
		const claimed = await this.prisma.imageVariantJob.updateMany({
			where: {
				jobKey: event.jobKey,
				status: {
					in: [
						ImageVariantJobState.Pending,
						ImageVariantJobState.Failed,
						ImageVariantJobState.Processing,
					],
				},
				nextAttemptAt: { lte: now },
				attempts: { lt: readVariantJobMaxAttempts() },
				asset: { status: ImageAssetState.Ready },
				variant: {
					status: {
						in: [ImageVariantState.Pending, ImageVariantState.Failed],
					},
				},
				OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
			},
			data: {
				status: ImageVariantJobState.Processing,
				leaseOwner: owner,
				leaseExpiresAt: new Date(
					now.getTime() + positiveInteger(leaseMs, 'leaseMs'),
				),
			},
		});
		return claimed.count === 1
			? { result: 'claimed', event }
			: { result: 'unavailable' };
	}

	async completeJob(
		event: ImageVariantJobEvent,
		result: CompleteVariantJobInput,
		afterComplete?: VariantTransactionWork,
	) {
		try {
			return await this.prisma.$transaction(async (transaction) => {
				const job = await transaction.imageVariantJob.findUniqueOrThrow({
					where: { jobKey: event.jobKey },
					select: { variantId: true },
				});
				const completed = await transaction.imageVariantJob.updateMany({
					where: {
						jobKey: event.jobKey,
						status: ImageVariantJobState.Processing,
						asset: { status: ImageAssetState.Ready },
						variant: {
							status: {
								in: [ImageVariantState.Pending, ImageVariantState.Failed],
							},
						},
					},
					data: {
						status: ImageVariantJobState.Completed,
						completedAt: new Date(),
						leaseOwner: null,
						leaseExpiresAt: null,
						lastError: null,
					},
				});
				if (completed.count !== 1) throw new VariantJobFencedError();
				const ready = await transaction.imageVariant.updateMany({
					where: {
						variantId: job.variantId,
						status: {
							in: [ImageVariantState.Pending, ImageVariantState.Failed],
						},
						asset: { status: ImageAssetState.Ready },
					},
					data: {
						status: ImageVariantState.Ready,
						storageKey: result.storageKey,
						bytes: result.outputBytes,
						checksum: result.checksum,
						readyAt: new Date(),
						failedAt: null,
						failureReason: null,
					},
				});
				if (ready.count !== 1) throw new VariantJobFencedError();
				const variant = await transaction.imageVariant.findUniqueOrThrow({
					where: { variantId: job.variantId },
				});
				await afterComplete?.(transaction, variant);
				return variant;
			});
		} catch (error) {
			if (error instanceof VariantJobFencedError) {
				const current = await this.prisma.imageVariantJob.findUnique({
					where: { jobKey: event.jobKey },
					include: { asset: true, variant: true },
				});
				return current?.status === ImageVariantJobState.Completed &&
					current.asset.status === ImageAssetState.Ready &&
					current.variant.status === ImageVariantState.Ready
					? current.variant
					: null;
			}
			throw error;
		}
	}

	async failJob(event: ImageVariantJobEvent, error: unknown) {
		const message = errorMessage(error);
		try {
			return await this.prisma.$transaction(async (transaction) => {
				const job = await transaction.imageVariantJob.findUniqueOrThrow({
					where: { jobKey: event.jobKey },
					select: { variantId: true, attempts: true },
				});
				const attempts = job.attempts + 1;
				const retryable = attempts < readVariantJobMaxAttempts();
				const nextAttemptAt = new Date(
					Date.now() + readVariantRetryBackoffMs(),
				);
				const failed = await transaction.imageVariantJob.updateMany({
					where: {
						jobKey: event.jobKey,
						status: ImageVariantJobState.Processing,
						asset: { status: ImageAssetState.Ready },
						variant: {
							status: {
								in: [ImageVariantState.Pending, ImageVariantState.Failed],
							},
						},
					},
					data: {
						status: ImageVariantJobState.Failed,
						attempts,
						nextAttemptAt,
						...(retryable
							? { publishedAt: null, nextPublishAt: nextAttemptAt }
							: {}),
						leaseOwner: null,
						leaseExpiresAt: null,
						lastError: message,
					},
				});
				if (failed.count !== 1) throw new VariantJobFencedError();
				const variant = await transaction.imageVariant.updateMany({
					where: {
						variantId: job.variantId,
						status: {
							in: [ImageVariantState.Pending, ImageVariantState.Failed],
						},
						asset: { status: ImageAssetState.Ready },
					},
					data: {
						status: ImageVariantState.Failed,
						failedAt: new Date(),
						failureReason: message,
					},
				});
				if (variant.count !== 1) throw new VariantJobFencedError();
				return transaction.imageVariantJob.findUniqueOrThrow({
					where: { jobKey: event.jobKey },
				});
			});
		} catch (caught) {
			if (caught instanceof VariantJobFencedError) return null;
			throw caught;
		}
	}

	async failVariant(variantId: string, error: unknown) {
		return this.prisma.$transaction(async (transaction) => {
			const existing = await transaction.imageVariant.findUniqueOrThrow({
				where: { variantId },
				include: { asset: true },
			});
			if (
				existing.status !== ImageVariantState.Ready ||
				existing.asset.status !== ImageAssetState.Ready
			) {
				return existing;
			}
			const now = new Date();
			const sourceChecksum = existing.asset.checksum ?? existing.sourceChecksum;
			const specKey = createImageVariantSpecKey({
				width: existing.width,
				height: existing.height,
				format: existing.format,
				sourceChecksum,
			});
			const failed = await transaction.imageVariant.updateMany({
				where: {
					variantId,
					status: ImageVariantState.Ready,
					updatedAt: existing.updatedAt,
					asset: { status: ImageAssetState.Ready },
				},
				data: {
					status: ImageVariantState.Failed,
					sourceChecksum,
					specKey,
					failedAt: now,
					failureReason: errorMessage(error),
				},
			});
			if (failed.count !== 1) {
				return transaction.imageVariant.findUniqueOrThrow({
					where: { variantId },
					include: { asset: true },
				});
			}

			const jobKey = createImageVariantJobKey({
				assetId: existing.assetId,
				width: existing.width ?? undefined,
				height: existing.height ?? undefined,
				format: normalizeFormat(existing.format),
				sourceChecksum,
			});
			await transaction.imageVariantJob.updateMany({
				where: { variantId, jobKey: { not: jobKey } },
				data: {
					status: ImageVariantJobState.Cancelled,
					leaseOwner: null,
					leaseExpiresAt: null,
				},
			});
			await transaction.imageVariantJob.createMany({
				data: [
					{
						assetId: existing.assetId,
						variantId,
						jobKey,
						status: ImageVariantJobState.Failed,
						nextAttemptAt: now,
						nextPublishAt: now,
					},
				],
				skipDuplicates: true,
			});
			const requeued = await transaction.imageVariantJob.updateMany({
				where: { jobKey, assetId: existing.assetId, variantId },
				data: {
					status: ImageVariantJobState.Failed,
					attempts: 0,
					nextAttemptAt: now,
					leaseOwner: null,
					leaseExpiresAt: null,
					lastError: errorMessage(error),
					completedAt: null,
					publishedAt: null,
					publishAttempts: 0,
					nextPublishAt: now,
					publishLastError: null,
				},
			});
			if (requeued.count !== 1) {
				throw new Error(
					`variant ${variantId} repair job could not be requeued`,
				);
			}
			return transaction.imageVariant.findUniqueOrThrow({
				where: { variantId },
			});
		});
	}

	findReadyVariant(input: {
		assetId: string;
		width?: number;
		height?: number;
		format: string;
		sourceChecksum: string;
	}) {
		const specKey = createImageVariantSpecKey(input);
		return this.prisma.imageVariant.findFirst({
			where: {
				assetId: input.assetId,
				specKey,
				status: ImageVariantState.Ready,
			},
		});
	}

	private withLeaseLockTimeout<T>(
		lockTimeoutMs: number,
		work: (transaction: Prisma.TransactionClient) => Promise<T>,
	) {
		const timeout = positiveInteger(lockTimeoutMs, 'lockTimeoutMs');
		return this.prisma.$transaction(async (transaction) => {
			await transaction.$executeRaw(
				Prisma.sql`SELECT set_config('lock_timeout', ${`${timeout}ms`}, true)`,
			);
			return work(transaction);
		});
	}
}

export function createImageVariantSpecKey(input: {
	width?: number | null;
	height?: number | null;
	format: string;
	sourceChecksum: string;
}) {
	const format = normalizeFormat(input.format);
	const checksum = input.sourceChecksum.trim().toLowerCase();
	if (!checksum) throw new Error('sourceChecksum is required');
	return `w=${input.width ?? 'auto'};h=${input.height ?? 'auto'};f=${format};s=${checksum}`;
}

function toVariantJobEvent(
	input: ReadyImageAssetForVariants,
	variant: ImageVariant,
	jobKey: string,
	createdAt: Date,
): ImageVariantJobEvent {
	return createImageVariantJobEvent({
		eventId: jobKey,
		occurredAt: createdAt.toISOString(),
		jobKey,
		assetId: input.assetId,
		clientServiceId: input.clientServiceId,
		path: input.logicalPath,
		name: input.name,
		sourceChecksum: input.sourceChecksum,
		width: variant.width ?? undefined,
		height: variant.height ?? undefined,
		format: normalizeFormat(variant.format),
	});
}

function createPendingVariantStorageKey(
	logicalPath: string,
	name: string,
	spec: ImageVariantSpec,
) {
	return `${logicalPath}/${createBoundedImageVariantName({
		path: logicalPath,
		name,
		width: spec.width,
		height: spec.height,
		format: normalizeFormat(spec.format),
	})}`;
}

function normalizeVariantSpecs(input: ReadyImageAssetForVariants) {
	const specs = new Map<
		string,
		ImageVariantSpec & {
			specKey: string;
			storageKey: string;
			format: ImageVariantJobFormat;
		}
	>();
	for (const requested of input.variants.slice(0, 1_000)) {
		const spec = {
			width: requested.width,
			height: requested.height,
			format: normalizeFormat(requested.format),
		};
		const specKey = createImageVariantSpecKey({
			...spec,
			sourceChecksum: input.sourceChecksum,
		});
		specs.set(specKey, {
			...spec,
			specKey,
			storageKey: createPendingVariantStorageKey(
				input.logicalPath,
				input.name,
				spec,
			),
		});
	}
	return [...specs.values()].sort((left, right) =>
		left.specKey.localeCompare(right.specKey),
	);
}

function resolveJobKey(job: string | Pick<ImageVariantJobEvent, 'jobKey'>) {
	return typeof job === 'string' ? job : job.jobKey;
}

function assertSameUploadIdentity(
	asset: ImageAsset,
	input: CreatePendingUploadInput,
) {
	if (
		asset.logicalPath !== input.logicalPath ||
		asset.name !== input.name ||
		asset.storageKey !== input.storageKey ||
		asset.originalName !== input.originalName ||
		asset.contentType !== input.contentType ||
		asset.inputBytes !== (input.inputBytes ?? null) ||
		asset.externalImageId !== (input.externalImageId ?? null)
	) {
		throw new Error(
			`idempotency key ${input.idempotencyKey} was reused for a different upload`,
		);
	}
}

function expectedFailureSourceStates(
	error: unknown,
	enqueueOutbox?: AssetTransactionWork,
): ImageAssetState[] {
	const message = errorMessage(error);
	if (message.startsWith('reconciliation: pending ')) {
		return [ImageAssetState.Pending];
	}
	if (message.startsWith('reconciliation: ready ')) {
		return [ImageAssetState.Ready];
	}
	return enqueueOutbox
		? [ImageAssetState.Pending, ImageAssetState.Failed]
		: [ImageAssetState.Pending, ImageAssetState.Ready, ImageAssetState.Failed];
}

function assertSourceEventIdentity(
	asset: ImageAsset,
	requestedSourceEventId: string,
) {
	if (!requestedSourceEventId.trim()) {
		throw new Error('sourceEventId is required');
	}
	if (
		asset.sourceEventId !== null &&
		asset.sourceEventId !== requestedSourceEventId
	) {
		throw new Error(
			`asset ${asset.assetId} is already bound to source event ${asset.sourceEventId}`,
		);
	}
	if (
		asset.status === ImageAssetState.Ready &&
		asset.sourceEventId !== requestedSourceEventId
	) {
		throw new Error(
			`ready asset ${asset.assetId} cannot be rebound to source event ${requestedSourceEventId}`,
		);
	}
}

function normalizeFormat(format: string): ImageVariantJobFormat {
	const normalized = format.trim().toLowerCase();
	switch (normalized) {
		case ImageVariantJobFormat.Png:
		case ImageVariantJobFormat.Jpeg:
		case ImageVariantJobFormat.Webp:
			return normalized;
		default:
			throw new Error(`unsupported variant format: ${format}`);
	}
}

function errorMessage(error: unknown) {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		MAX_ERROR_LENGTH,
	);
}

function boundedLimit(value: number, max = 1_000) {
	const parsed = positiveInteger(value, 'limit');
	return Math.min(parsed, max);
}

function positiveInteger(value: number, name: string) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function readVariantJobMaxAttempts() {
	const parsed = Number(process.env.IMAGE_VARIANT_JOB_MAX_ATTEMPTS);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 3;
}

function readVariantRetryBackoffMs() {
	const parsed = Number(process.env.IMAGE_VARIANT_JOB_RETRY_BACKOFF_MS);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1_000;
}
