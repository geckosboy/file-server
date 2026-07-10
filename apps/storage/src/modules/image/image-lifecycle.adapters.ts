import { Injectable, Logger } from '@nestjs/common';
import { ImageAsset, ImageAssetState, ImageVariantState } from '@prisma/client';
import {
	ImageAssetMetadataRepository,
	type ImageVariantJobEvent,
} from '@file/database';
import type { ImageVariantJobEvent as SharedImageVariantJobEvent } from '@file/telemetry-contracts/image-operations';
import { createImageCacheInvalidationEvent } from '@file/telemetry-contracts/image-operations';
import { splitAndNormalizeImageKey } from '@file/image-contracts';
import { randomUUID } from 'crypto';
import {
	ImageAssetLifecycleMetadataPort,
	ImageAssetLifecycleStatus,
	ImageAssetReconciliationRecord,
	ImageCacheInvalidationPort,
	PendingImageAsset,
} from './image-asset-lifecycle.service';
import { ImageCacheInvalidationPublisher } from './image-cache-invalidation.publisher';
import { ImageLifecycleOutboxService } from './image-lifecycle-outbox.service';
import {
	createImageLifecycleEvent,
	ImageLifecycleEvent,
	ImageLifecycleEventType,
	ImageLifecycleStatus,
} from './image.lifecycle';
import { ImagePregenerationService } from './image-pregeneration.service';
import { ImageVariantJobDispatcher } from './image-variant-job.dispatcher';
import {
	CompletedImageVariant,
	ImageVariantJobRepository,
	ReadyImageAssetForVariants,
} from './image-variant-job.repository';
import { normalizeImageFormat } from './image.telemetry';

@Injectable()
export class ImageAssetLifecycleMetadataAdapter implements ImageAssetLifecycleMetadataPort {
	private readonly logger = new Logger(ImageAssetLifecycleMetadataAdapter.name);

	constructor(
		private readonly repository: ImageAssetMetadataRepository,
		private readonly lifecycleOutbox: ImageLifecycleOutboxService,
		private readonly pregeneration: ImagePregenerationService,
		private readonly variantDispatcher: ImageVariantJobDispatcher,
	) {}

	async createPendingUpload(
		input: Parameters<
			ImageAssetLifecycleMetadataPort['createPendingUpload']
		>[0],
	): Promise<PendingImageAsset> {
		const asset = await this.repository.createPendingUpload({
			clientServiceId: input.clientServiceId,
			idempotencyKey: input.idempotencyKey,
			externalImageId: input.externalImageId,
			logicalPath: input.logicalPath,
			name: input.name,
			originalName: input.originalName,
			storageKey: `${input.path}/${input.name}`,
			contentType: input.contentType,
			inputBytes: input.inputBytes,
		});
		if (!asset) {
			throw new Error('Authoritative image metadata writes are disabled');
		}
		return {
			assetId: asset.assetId,
			clientServiceId: asset.clientServiceId,
			source: { path: asset.logicalPath, name: asset.name },
			status: toLifecycleStatus(asset.status),
			sourceEventId: asset.sourceEventId,
		};
	}

	async getAssetStatus(assetId: string) {
		const asset = await this.repository.findAssetById(assetId);
		return asset ? toLifecycleStatus(asset.status) : null;
	}

	async completeUpload(
		input: Parameters<ImageAssetLifecycleMetadataPort['completeUpload']>[0],
	) {
		const existing = await this.repository.findAssetById(input.assetId);
		if (!existing) throw new Error(`image asset ${input.assetId} is missing`);
		const eventId =
			existing.sourceEventId ?? input.lifecycleEvent?.eventId ?? randomUUID();
		const event = createUploadEvent(
			existing,
			input.object,
			eventId,
			input.lifecycleEvent,
		);
		const variants = await this.pregeneration.listActiveVariantSpecs(
			existing.clientServiceId,
		);
		let jobs: ImageVariantJobEvent[] = [];
		const ready = await this.repository.completeUpload(
			{
				assetId: input.assetId,
				sourceEventId: eventId,
				bytes: input.object.bytes,
				checksum: input.object.checksum,
				format: input.format,
				width: input.width,
				height: input.height,
			},
			async (transaction, ready) => {
				await this.lifecycleOutbox.enqueueWithinTransaction(transaction, event);
				jobs = await this.repository.createPendingJobsWithinTransaction(
					transaction,
					{
						assetId: ready.assetId,
						clientServiceId: ready.clientServiceId,
						logicalPath: ready.logicalPath,
						name: ready.name,
						storageKey: ready.storageKey,
						sourceChecksum: input.object.checksum,
						variants,
					},
				);
			},
		);
		this.wakePublishers(jobs);
		return {
			eventId: ready.sourceEventId ?? eventId,
			variantStatus:
				jobs.length > 0
					? ('Pending' as const)
					: await this.repository.getVariantStatus(ready.assetId),
		};
	}

	async repairReadyAsset(
		input: Parameters<
			NonNullable<ImageAssetLifecycleMetadataPort['repairReadyAsset']>
		>[0],
	): Promise<void> {
		const existing = await this.repository.findAssetById(input.assetId);
		if (!existing) throw new Error(`image asset ${input.assetId} is missing`);
		const variants = await this.pregeneration.listActiveVariantSpecs(
			existing.clientServiceId,
		);
		let jobs: ImageVariantJobEvent[] = [];
		await this.repository.repairReadyAssetMetadata(
			{
				assetId: input.assetId,
				bytes: input.object.bytes,
				checksum: input.object.checksum,
				format: input.format,
				width: input.width,
				height: input.height,
			},
			async (transaction, ready) => {
				jobs = await this.repository.createPendingJobsWithinTransaction(
					transaction,
					{
						assetId: ready.assetId,
						clientServiceId: ready.clientServiceId,
						logicalPath: ready.logicalPath,
						name: ready.name,
						storageKey: ready.storageKey,
						sourceChecksum: input.object.checksum,
						variants,
					},
				);
			},
		);
		this.wakePublishers(jobs);
	}

	async failAsset(input: {
		assetId: string;
		reason: string;
		lifecycleEvent?: ImageLifecycleEvent;
	}): Promise<void> {
		await this.repository.failAsset(
			input.assetId,
			input.reason,
			input.lifecycleEvent
				? async (transaction) => {
						await this.lifecycleOutbox.enqueueWithinTransaction(
							transaction,
							input.lifecycleEvent!,
						);
					}
				: undefined,
		);
		if (input.lifecycleEvent) this.wakePublishers();
	}

	async beginDelete(
		input: Parameters<ImageAssetLifecycleMetadataPort['beginDelete']>[0],
	) {
		const existing = await this.repository.findAssetForDelete({
			clientServiceId: input.clientServiceId,
			logicalPath: input.path,
			name: input.name,
		});
		if (!existing) return null;
		if (existing.status === ImageAssetState.Deleted) {
			return { status: 'Deleted' as const };
		}
		const deleting = await this.repository.beginDelete(
			existing.assetId,
			existing.deleteEventId ?? randomUUID(),
		);
		if (!deleting) return null;
		if (deleting.status === ImageAssetState.Deleted) {
			return { status: 'Deleted' as const };
		}
		if (!deleting.deleteEventId) {
			throw new Error(
				`delete eventId was not persisted for ${deleting.assetId}`,
			);
		}
		return {
			assetId: deleting.assetId,
			clientServiceId: deleting.clientServiceId,
			eventId: deleting.deleteEventId,
			status: 'Deleting' as const,
			source: { path: deleting.logicalPath, name: deleting.name },
			variants: deleting.variants.map((variant) => ({
				variantId: variant.variantId,
				object: splitStorageKey(variant.storageKey),
			})),
		};
	}

	async completeDelete(input: {
		assetId: string;
		eventId: string;
		cacheInvalidation: Parameters<
			ImageLifecycleOutboxService['enqueueCacheInvalidationWithinTransaction']
		>[1];
	}) {
		let event: ImageLifecycleEvent | undefined;
		await this.repository.completeDelete(
			input.assetId,
			async (transaction, asset, deleteEventId) => {
				assertDeleteEventId(input.eventId, deleteEventId);
				event = createDeleteEvent(
					asset,
					deleteEventId,
					ImageLifecycleEventType.DeleteCompleted,
				);
				await this.lifecycleOutbox.enqueueWithinTransaction(transaction, event);
				await this.lifecycleOutbox.enqueueCacheInvalidationWithinTransaction(
					transaction,
					input.cacheInvalidation,
				);
			},
		);
		if (event) this.wakePublishers();
	}

	async recordDeleteFailure(input: {
		assetId: string;
		eventId: string;
		reason: string;
	}) {
		const asset = await this.repository.recordDeleteFailure(
			input.assetId,
			input.reason,
		);
		assertDeleteEventId(input.eventId, asset.deleteEventId ?? '');
	}

	async listReconciliationCandidates(input: {
		updatedBefore: Date;
		limit: number;
	}): Promise<ImageAssetReconciliationRecord[]> {
		const rows = await this.repository.listReconciliationCandidates(
			input.updatedBefore,
			input.limit,
		);
		return rows.flatMap((asset) => {
			if (
				asset.status === ImageAssetState.Deleted ||
				asset.status === ImageAssetState.Failed
			) {
				return [];
			}
			return [
				{
					assetId: asset.assetId,
					clientServiceId: asset.clientServiceId,
					source: { path: asset.logicalPath, name: asset.name },
					sourceChecksum: asset.checksum,
					deleteEventId: asset.deleteEventId,
					status: toReconciliationStatus(asset.status),
					updatedAt: asset.updatedAt,
					variants: asset.variants.map((variant) => ({
						variantId: variant.variantId,
						status: toLifecycleStatus(variant.status),
						sourceChecksum: variant.sourceChecksum,
						object: splitStorageKey(variant.storageKey),
					})),
				},
			];
		});
	}

	listTrackedStorageKeys(storageKeys: string[]) {
		return this.repository.listTrackedStorageKeys(storageKeys);
	}

	listDeletedStorageKeys(storageKeys: string[]) {
		return this.repository.listDeletedStorageKeys(storageKeys);
	}

	async listRecentlyDeletedObjects(limit: number) {
		return (await this.repository.listRecentlyDeletedStorageKeys(limit)).map(
			splitStorageKey,
		);
	}

	async failVariant(input: { variantId: string; reason: string }) {
		await this.repository.failVariant(input.variantId, input.reason);
	}

	async tryAcquireReconciliationLease(input: {
		owner: string;
		leaseMs: number;
		lockTimeoutMs: number;
	}) {
		const token = await this.repository.tryAcquireReconciliationLease(
			input.owner,
			input.leaseMs,
			input.lockTimeoutMs,
		);
		return token ? { token } : null;
	}

	async renewReconciliationLease(input: {
		owner: string;
		token: string;
		leaseMs: number;
	}) {
		const result = await this.repository.renewReconciliationLease(
			input.owner,
			input.token,
			input.leaseMs,
		);
		return result.count === 1;
	}

	async releaseReconciliationLease(input: { owner: string; token: string }) {
		await this.repository.releaseReconciliationLease(input.owner, input.token);
	}

	async getReconciliationBacklogMetrics() {
		const metrics = await this.repository.getReconciliationBacklogMetrics();
		return {
			failedCount: metrics.failedCount,
			oldestPendingAt: metrics.oldestPendingAt,
			oldestDeletingAt: metrics.oldestDeletingAt,
		};
	}

	async recordReconciliationResult(
		report: Parameters<
			NonNullable<ImageAssetLifecycleMetadataPort['recordReconciliationResult']>
		>[0],
	) {
		await this.repository.recordReconciliationResult({
			orphanCount:
				report.detectedOrphanObjects +
				report.recoveredPendingAssets +
				report.failedAssets +
				report.failedVariants +
				report.completedDeletes +
				report.removedDeletedObjects +
				report.removedStagedObjects +
				report.removedInboundTempFiles,
			repairedCount:
				report.recoveredPendingAssets +
				report.completedDeletes +
				report.removedOrphanObjects +
				report.removedDeletedObjects +
				report.removedStagedObjects +
				report.removedInboundTempFiles,
			failedCount: report.errors + report.failedAssets + report.failedVariants,
			oldestPendingAgeMs: report.oldestPendingAgeMs,
			oldestDeletingAgeMs: report.oldestDeletingAgeMs,
			durationMs: report.durationMs,
		});
	}

	async recordReconciliationFailure(input: {
		error: unknown;
		durationMs: number;
	}) {
		await this.repository.recordReconciliationFailure(
			input.error,
			input.durationMs,
		);
	}

	getMetricsSnapshot(): Promise<Record<string, unknown>> {
		return this.repository.getMetricsSnapshot();
	}

	private wakePublishers(jobs: ImageVariantJobEvent[] = []) {
		this.variantDispatcher.publishPersisted(jobs);
		void this.lifecycleOutbox.publishPending().catch((error: unknown) => {
			this.logger.warn(
				`Image lifecycle publisher wakeup failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		});
	}
}

@Injectable()
export class ImageCacheInvalidationAdapter implements ImageCacheInvalidationPort {
	constructor(private readonly publisher: ImageCacheInvalidationPublisher) {}

	async invalidateAsset(input: {
		assetId: string;
		eventId: string;
		clientServiceId: string;
		storageKeys: string[];
	}): Promise<void> {
		const sourceStorageKey = input.storageKeys[0];
		if (!sourceStorageKey) return;
		const target = splitStorageKey(sourceStorageKey);
		const published = await this.publisher.publish({
			eventId: input.eventId,
			clientServiceId: input.clientServiceId,
			path: toPublicCachePath(target.path),
			name: target.name,
			reason: 'delete',
			assetId: input.assetId,
		});
		if (!published) {
			throw new Error(
				`cache invalidation publish failed for ${sourceStorageKey}`,
			);
		}
	}
}

@Injectable()
export class ImageVariantJobRepositoryAdapter implements ImageVariantJobRepository {
	constructor(
		private readonly repository: ImageAssetMetadataRepository,
		private readonly lifecycleOutbox: ImageLifecycleOutboxService,
	) {}

	createPendingJobs(input: ReadyImageAssetForVariants) {
		return this.repository.createPendingJobs({
			assetId: input.assetId,
			clientServiceId: input.clientServiceId,
			logicalPath: input.path,
			name: input.name,
			storageKey: `${input.path}/${input.name}`,
			sourceChecksum: input.sourceChecksum,
			variants: input.variants,
		});
	}

	listPublishableJobs(limit: number): Promise<SharedImageVariantJobEvent[]> {
		return this.repository.listPublishableJobs(limit);
	}

	async recordPublished(jobKey: string): Promise<void> {
		await this.repository.recordPublished(jobKey);
	}

	async recordPublishFailure(jobKey: string, error: unknown): Promise<void> {
		await this.repository.recordPublishFailure(jobKey, error);
	}

	async claimJob(job: SharedImageVariantJobEvent) {
		return (await this.repository.claimJob(job)).result;
	}

	async completeJob(
		job: SharedImageVariantJobEvent,
		result: CompletedImageVariant,
	): Promise<boolean> {
		if (!result.checksum) throw new Error('variant checksum is required');
		const completed = await this.repository.completeJob(
			job,
			{
				...result,
				checksum: result.checksum,
			},
			async (transaction) => {
				await this.lifecycleOutbox.enqueueCacheInvalidationWithinTransaction(
					transaction,
					createImageCacheInvalidationEvent({
						eventId: `variant-ready:${job.jobKey}`,
						clientServiceId: job.clientServiceId,
						path: toPublicCachePath(job.path),
						name: job.name,
						reason: 'variant-ready',
						assetId: job.assetId,
						sourceChecksum: job.sourceChecksum,
					}),
				);
			},
		);
		void this.lifecycleOutbox.publishPending().catch(() => undefined);
		return completed !== null;
	}

	async failJob(
		job: SharedImageVariantJobEvent,
		error: unknown,
	): Promise<void> {
		await this.repository.failJob(job, error);
	}
}

function createUploadEvent(
	asset: ImageAsset,
	object: Parameters<
		ImageAssetLifecycleMetadataPort['completeUpload']
	>[0]['object'],
	eventId: string,
	provided?: ImageLifecycleEvent,
) {
	if (provided?.eventId === eventId) return provided;
	return createImageLifecycleEvent({
		eventId,
		eventType: ImageLifecycleEventType.UploadCompleted,
		clientServiceId: asset.clientServiceId,
		imageId: asset.externalImageId ?? undefined,
		path: asset.logicalPath,
		name: asset.name,
		originalName: asset.originalName,
		imageKey: asset.storageKey,
		format: normalizeImageFormat(object.format ?? asset.name),
		inputBytes: asset.inputBytes ?? undefined,
		outputBytes: object.bytes,
		durationMs: 0,
		status: ImageLifecycleStatus.Success,
	});
}

function createDeleteEvent(
	asset: ImageAsset,
	eventId: string,
	eventType:
		| typeof ImageLifecycleEventType.DeleteCompleted
		| typeof ImageLifecycleEventType.DeleteFailed,
	error?: string,
) {
	return createImageLifecycleEvent({
		eventId,
		eventType,
		clientServiceId: asset.clientServiceId,
		imageId: asset.externalImageId ?? undefined,
		path: asset.logicalPath,
		name: asset.name,
		imageKey: asset.storageKey,
		format: normalizeImageFormat(asset.format ?? asset.name),
		status:
			eventType === ImageLifecycleEventType.DeleteCompleted
				? ImageLifecycleStatus.Success
				: ImageLifecycleStatus.Failed,
		...(error ? { errorCode: 'IMAGE_DELETE_FAILED', errorMessage: error } : {}),
	});
}

function splitStorageKey(storageKey: string) {
	return splitAndNormalizeImageKey(storageKey);
}

function toPublicCachePath(path: string) {
	return path.endsWith('/image') ? path.slice(0, -'/image'.length) : path;
}

function assertDeleteEventId(expected: string, actual: string) {
	if (expected !== actual) {
		throw new Error(
			`delete eventId changed across retry: expected ${expected}, received ${actual}`,
		);
	}
}

function toLifecycleStatus(
	status: ImageAssetState | ImageVariantState,
): ImageAssetLifecycleStatus {
	switch (status) {
		case ImageAssetState.Pending:
			return 'Pending';
		case ImageAssetState.Ready:
			return 'Ready';
		case ImageAssetState.Deleting:
			return 'Deleting';
		case ImageAssetState.Deleted:
			return 'Deleted';
		case ImageAssetState.Failed:
			return 'Failed';
	}
}

function toReconciliationStatus(
	status:
		| typeof ImageAssetState.Pending
		| typeof ImageAssetState.Ready
		| typeof ImageAssetState.Deleting,
): ImageAssetReconciliationRecord['status'] {
	switch (status) {
		case ImageAssetState.Pending:
			return 'Pending';
		case ImageAssetState.Ready:
			return 'Ready';
		case ImageAssetState.Deleting:
			return 'Deleting';
	}
}
