import {
	ConflictException,
	Inject,
	Injectable,
	Logger,
	Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
	ImageCacheInvalidationEvent,
	createImageCacheInvalidationEvent,
} from '@file/telemetry-contracts/image-operations';
import { SharpStrategy } from './strategies/sharp';
import {
	ImageFilesystemStore,
	ImageObjectAddress,
	ImageObjectInspection,
	StagedImageObject,
} from './image-filesystem.store';
import {
	createImageLifecycleEvent,
	ImageLifecycleEvent,
	ImageLifecycleEventType,
	ImageLifecycleStatus,
} from './image.lifecycle';
import { normalizeImageFormat } from './image.telemetry';
import {
	ImageLifecycleFailpoint,
	ImageLifecycleFailpointService,
} from './image-lifecycle.failpoints';

export const IMAGE_ASSET_LIFECYCLE_METADATA = Symbol(
	'IMAGE_ASSET_LIFECYCLE_METADATA',
);
export const IMAGE_CACHE_INVALIDATION_PORT = Symbol(
	'IMAGE_CACHE_INVALIDATION_PORT',
);

export type ImageAssetLifecycleStatus =
	'Pending' | 'Ready' | 'Deleting' | 'Deleted' | 'Failed';

export interface CreatePendingImageAssetInput extends ImageObjectAddress {
	idempotencyKey: string;
	clientServiceId: string;
	logicalPath: string;
	originalName: string;
	contentType: string;
	inputBytes: number;
	externalImageId?: number;
	clientServiceSlug?: string;
	requestId?: string;
	traceId?: string;
}

export interface PendingImageAsset {
	assetId: string;
	clientServiceId: string;
	source: ImageObjectAddress;
	status?: ImageAssetLifecycleStatus;
	sourceEventId?: string | null;
}

export type ImageVariantUploadStatus =
	'Pending' | 'Ready' | 'Failed' | 'NotConfigured';

export interface CompleteImageAssetUploadResult {
	eventId: string;
	variantStatus: ImageVariantUploadStatus;
}

export interface ImageAssetUploadResult extends CompleteImageAssetUploadResult {
	assetId: string;
	path: string;
	name: string;
	storageKey: string;
	checksum: string;
	size: number;
	format: string;
	width?: number;
	height?: number;
	durationMs: number;
}

export interface ImageAssetDeleteRecord extends PendingImageAsset {
	eventId: string;
	status: 'Deleting';
	variants: Array<{
		variantId: string;
		object: ImageObjectAddress;
	}>;
}

export interface DeletedImageAssetRecord {
	status: 'Deleted';
}

export interface ImageAssetReconciliationRecord extends PendingImageAsset {
	deleteEventId?: string | null;
	sourceChecksum?: string | null;
	status: Exclude<ImageAssetLifecycleStatus, 'Deleted' | 'Failed'>;
	updatedAt: Date;
	variants: Array<{
		variantId: string;
		status: ImageAssetLifecycleStatus;
		sourceChecksum?: string | null;
		object: ImageObjectAddress;
	}>;
}

export interface ImageReconciliationBacklogMetrics {
	failedCount: number;
	oldestPendingAt: Date | null;
	oldestDeletingAt: Date | null;
}

export interface ImageAssetLifecycleMetadataPort {
	createPendingUpload(
		input: CreatePendingImageAssetInput,
	): Promise<PendingImageAsset>;
	getAssetStatus(assetId: string): Promise<ImageAssetLifecycleStatus | null>;
	/** Ready metadata와 upload lifecycle outbox를 한 transaction으로 완료한다. */
	completeUpload(input: {
		assetId: string;
		object: ImageObjectInspection;
		format: string;
		width?: number;
		height?: number;
		lifecycleEvent?: ImageLifecycleEvent;
	}): Promise<CompleteImageAssetUploadResult | void>;
	repairReadyAsset?(input: {
		assetId: string;
		object: ImageObjectInspection;
		format: string;
		width?: number;
		height?: number;
	}): Promise<void>;
	failAsset(input: {
		assetId: string;
		reason: string;
		lifecycleEvent?: ImageLifecycleEvent;
	}): Promise<void>;
	beginDelete(input: {
		clientServiceId: string;
		path: string;
		name: string;
	}): Promise<ImageAssetDeleteRecord | DeletedImageAssetRecord | null>;
	/** Deleted metadata와 delete lifecycle outbox를 한 transaction으로 완료한다. */
	completeDelete(input: {
		assetId: string;
		eventId: string;
		cacheInvalidation: ImageCacheInvalidationEvent;
	}): Promise<void>;
	recordDeleteFailure(input: {
		assetId: string;
		eventId: string;
		reason: string;
	}): Promise<void>;
	listReconciliationCandidates(input: {
		updatedBefore: Date;
		limit: number;
	}): Promise<ImageAssetReconciliationRecord[]>;
	listTrackedStorageKeys(storageKeys: string[]): Promise<string[]>;
	listDeletedStorageKeys(storageKeys: string[]): Promise<string[]>;
	listRecentlyDeletedObjects(limit: number): Promise<ImageObjectAddress[]>;
	failVariant(input: { variantId: string; reason: string }): Promise<void>;
	tryAcquireReconciliationLease(input: {
		owner: string;
		leaseMs: number;
		lockTimeoutMs: number;
	}): Promise<{ token: string } | null>;
	renewReconciliationLease(input: {
		owner: string;
		token: string;
		leaseMs: number;
	}): Promise<boolean>;
	releaseReconciliationLease(input: {
		owner: string;
		token: string;
	}): Promise<void>;
	getReconciliationBacklogMetrics(): Promise<ImageReconciliationBacklogMetrics>;
	recordReconciliationResult?(report: ImageReconciliationReport): Promise<void>;
	recordReconciliationFailure?(input: {
		error: unknown;
		durationMs: number;
	}): Promise<void>;
}

export interface ImageCacheInvalidationPort {
	invalidateAsset(input: {
		assetId: string;
		eventId: string;
		clientServiceId: string;
		storageKeys: string[];
	}): Promise<void>;
}

export interface ImageReconciliationReport {
	leaseAcquired: boolean;
	checkedAssets: number;
	recoveredPendingAssets: number;
	failedAssets: number;
	failedVariants: number;
	completedDeletes: number;
	detectedOrphanObjects: number;
	removedOrphanObjects: number;
	removedDeletedObjects: number;
	removedStagedObjects: number;
	removedInboundTempFiles: number;
	errors: number;
	failedCount: number;
	oldestPendingAgeMs: number | null;
	oldestDeletingAgeMs: number | null;
	durationMs: number;
}

export class ImageAssetDeleteFailure extends Error {
	constructor(
		readonly eventId: string,
		readonly cause: unknown,
	) {
		super(errorMessage(cause));
		this.name = ImageAssetDeleteFailure.name;
	}
}

@Injectable()
export class ImageAssetLifecycleService {
	private readonly logger = new Logger(ImageAssetLifecycleService.name);
	private objectScanCursor?: string;
	private stageScanCursor?: string;
	private inboundTempScanCursor?: string;

	constructor(
		private readonly filesystem: ImageFilesystemStore,
		@Inject(IMAGE_ASSET_LIFECYCLE_METADATA)
		private readonly metadata: ImageAssetLifecycleMetadataPort,
		@Inject(IMAGE_CACHE_INVALIDATION_PORT)
		private readonly cacheInvalidation: ImageCacheInvalidationPort,
		@Optional() private readonly failpoints?: ImageLifecycleFailpointService,
	) {}

	async upload<T extends SharpStrategy>(
		strategy: T,
		input: CreatePendingImageAssetInput & { tempName: string },
	): Promise<ImageAssetUploadResult> {
		const startedAt = performance.now();
		const pending = await this.metadata.createPendingUpload({
			...input,
			idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
		});
		this.failpoints?.trigger(ImageLifecycleFailpoint.AfterPending);
		if (pending.status === 'Deleting' || pending.status === 'Deleted') {
			throw new ConflictException(
				`asset ${pending.assetId} is deleting or already deleted`,
			);
		}
		const eventId = pending.sourceEventId ?? randomUUID();
		if (pending.status === 'Ready') {
			const existing = await this.filesystem.inspectObject(pending.source);
			if (!existing) {
				throw new Error('idempotent Ready upload source object is missing');
			}
			const durationMs = performance.now() - startedAt;
			const completion = await this.metadata.completeUpload({
				assetId: pending.assetId,
				object: existing,
				format: existing.format ?? formatFromName(existing.name),
				width: existing.width,
				height: existing.height,
				lifecycleEvent: createUploadLifecycleEvent(
					input,
					existing,
					eventId,
					durationMs,
				),
			});
			return toUploadResult(
				pending.assetId,
				existing,
				durationMs,
				completion,
				eventId,
			);
		}
		let staged: StagedImageObject | undefined;
		try {
			staged = await this.filesystem.stageImage(strategy, {
				...pending.source,
				tempName: input.tempName,
			});
			this.failpoints?.trigger(ImageLifecycleFailpoint.BeforePromote);
			await this.filesystem.promoteImage(staged);
			this.failpoints?.trigger(ImageLifecycleFailpoint.AfterPromote);
			const durationMs = performance.now() - startedAt;
			const lifecycleEvent = createUploadLifecycleEvent(
				input,
				toInspection(staged),
				eventId,
				durationMs,
			);
			this.failpoints?.trigger(ImageLifecycleFailpoint.BeforeReadyTransaction);
			const completion = await this.metadata.completeUpload({
				assetId: pending.assetId,
				object: toInspection(staged),
				format: staged.format,
				width: staged.width,
				height: staged.height,
				lifecycleEvent,
			});
			this.failpoints?.trigger(ImageLifecycleFailpoint.AfterReadyTransaction);

			return toUploadResult(
				pending.assetId,
				toInspection(staged),
				durationMs,
				completion,
				eventId,
			);
		} catch (error) {
			const promoted = await this.filesystem.hasObject(pending.source);
			if (promoted) {
				const currentStatus = await this.metadata
					.getAssetStatus(pending.assetId)
					.catch(() => null);
				if (currentStatus === 'Deleting' || currentStatus === 'Deleted') {
					await this.filesystem.deleteObjects([pending.source]);
				}
			} else {
				if (staged) {
					await this.filesystem.discardStage(staged).catch(() => undefined);
				}
				await this.metadata.failAsset({
					assetId: pending.assetId,
					reason: errorMessage(error),
					lifecycleEvent: createUploadFailureLifecycleEvent(
						input,
						eventId,
						error,
						performance.now() - startedAt,
					),
				});
			}
			throw error;
		}
	}

	async delete(input: {
		clientServiceId: string;
		path: string;
		name: string;
	}): Promise<{
		alreadyDeleted: boolean;
		eventId?: string;
		metadataMissing?: boolean;
	}> {
		const deleting = await this.metadata.beginDelete(input);
		if (!deleting) {
			return { alreadyDeleted: true, metadataMissing: true };
		}
		if (deleting.status === 'Deleted') {
			return { alreadyDeleted: true };
		}

		try {
			await this.finishDelete(deleting);
			return { alreadyDeleted: false, eventId: deleting.eventId };
		} catch (error) {
			throw new ImageAssetDeleteFailure(deleting.eventId, error);
		}
	}

	async reconcile(input: {
		updatedBefore: Date;
		orphanedBefore?: Date;
		limit?: number;
		objectScanLimit?: number;
		stageCleanupLimit?: number;
		inboundTempCleanupLimit?: number;
		deleteOrphanObjects?: boolean;
		leaseOwner?: string;
		leaseMs?: number;
		lockTimeoutMs?: number;
		now?: Date;
	}): Promise<ImageReconciliationReport> {
		const startedAt = performance.now();
		const report: ImageReconciliationReport = {
			leaseAcquired: false,
			checkedAssets: 0,
			recoveredPendingAssets: 0,
			failedAssets: 0,
			failedVariants: 0,
			completedDeletes: 0,
			detectedOrphanObjects: 0,
			removedOrphanObjects: 0,
			removedDeletedObjects: 0,
			removedStagedObjects: 0,
			removedInboundTempFiles: 0,
			errors: 0,
			failedCount: 0,
			oldestPendingAgeMs: null,
			oldestDeletingAgeMs: null,
			durationMs: 0,
		};
		const leaseOwner = input.leaseOwner ?? `storage-${process.pid}`;
		const leaseMs = normalizePositiveInteger(input.leaseMs, 55_000);
		const lease = await this.metadata.tryAcquireReconciliationLease({
			owner: leaseOwner,
			leaseMs,
			lockTimeoutMs: normalizePositiveInteger(input.lockTimeoutMs, 2_000),
		});
		if (!lease) {
			report.durationMs = Math.round(performance.now() - startedAt);
			return report;
		}
		report.leaseAcquired = true;
		let leaseHealthy = true;
		let leaseRenewalError: unknown;
		let leaseRenewal = Promise.resolve();
		const heartbeat = setInterval(
			() => {
				leaseRenewal = leaseRenewal
					.then(async () => {
						leaseHealthy = await this.metadata.renewReconciliationLease({
							owner: leaseOwner,
							token: lease.token,
							leaseMs,
						});
					})
					.catch((error: unknown) => {
						leaseRenewalError = error;
						leaseHealthy = false;
					});
			},
			Math.max(10, Math.floor(leaseMs / 2)),
		);
		heartbeat.unref?.();
		const assertLeaseHealthy = async () => {
			await leaseRenewal;
			if (leaseRenewalError) {
				throw leaseRenewalError;
			}
			if (!leaseHealthy) {
				throw new Error('image reconciliation lease was lost');
			}
		};

		try {
			const recentlyDeleted = await this.metadata.listRecentlyDeletedObjects(
				normalizePositiveInteger(input.objectScanLimit, 1_000),
			);
			const deletedObjectsStillPresent: ImageObjectAddress[] = [];
			for (const object of recentlyDeleted) {
				if (await this.filesystem.hasObject(object)) {
					deletedObjectsStillPresent.push(object);
				}
			}
			await this.filesystem.deleteObjects(deletedObjectsStillPresent);
			report.removedDeletedObjects = deletedObjectsStillPresent.length;
			await assertLeaseHealthy();

			const candidates = await this.metadata.listReconciliationCandidates({
				updatedBefore: input.updatedBefore,
				limit: normalizePositiveInteger(input.limit, 100),
			});
			report.checkedAssets = candidates.length;

			for (const candidate of candidates) {
				try {
					if (candidate.status === 'Pending') {
						const source = await this.filesystem.inspectObject(
							candidate.source,
						);
						if (!source) {
							await this.metadata.failAsset({
								assetId: candidate.assetId,
								reason: 'reconciliation: pending source object is missing',
							});
							report.failedAssets += 1;
							await assertLeaseHealthy();
							continue;
						}
						await this.metadata.completeUpload({
							assetId: candidate.assetId,
							object: source,
							format: source.format ?? formatFromName(source.name),
							width: source.width,
							height: source.height,
						});
						report.recoveredPendingAssets += 1;
						await assertLeaseHealthy();
						continue;
					}

					if (candidate.status === 'Deleting') {
						if (!candidate.deleteEventId) {
							throw new Error(
								'reconciliation: deleting asset eventId is missing',
							);
						}
						await this.finishDelete({
							...candidate,
							eventId: candidate.deleteEventId,
						});
						report.completedDeletes += 1;
						await assertLeaseHealthy();
						continue;
					}

					const source = await this.filesystem.inspectObject(candidate.source);
					if (!source) {
						await this.metadata.failAsset({
							assetId: candidate.assetId,
							reason: 'reconciliation: ready source object is missing',
						});
						report.failedAssets += 1;
						await assertLeaseHealthy();
						continue;
					}
					if (
						candidate.sourceChecksum &&
						candidate.sourceChecksum !== source.checksum
					) {
						await this.metadata.failAsset({
							assetId: candidate.assetId,
							reason: 'reconciliation: ready source checksum changed',
						});
						report.failedAssets += 1;
						await assertLeaseHealthy();
						continue;
					}
					await this.metadata.repairReadyAsset?.({
						assetId: candidate.assetId,
						object: source,
						format: source.format ?? formatFromName(source.name),
						width: source.width,
						height: source.height,
					});

					for (const variant of candidate.variants) {
						if (variant.status !== 'Ready') {
							continue;
						}
						const variantExists = await this.filesystem.hasObject(
							variant.object,
						);
						const checksumMatches =
							!variant.sourceChecksum ||
							variant.sourceChecksum === source.checksum;
						if (!variantExists || !checksumMatches) {
							await this.metadata.failVariant({
								variantId: variant.variantId,
								reason: !variantExists
									? 'reconciliation: ready variant object is missing'
									: 'reconciliation: variant source checksum is stale',
							});
							report.failedVariants += 1;
						}
					}
				} catch (error) {
					report.errors += 1;
					this.logger.warn({
						event: 'image_reconciliation_asset_failed',
						assetId: candidate.assetId,
						status: candidate.status,
						error: errorMessage(error),
					});
				}
				await assertLeaseHealthy();
			}

			const stageScan = await this.filesystem.scanAndCleanupStagedObjects({
				olderThan: input.updatedBefore,
				limit: normalizePositiveInteger(input.stageCleanupLimit, 1_000),
				cursor: this.stageScanCursor,
			});
			this.stageScanCursor = stageScan.nextCursor ?? undefined;
			report.removedStagedObjects = stageScan.items.length;
			await assertLeaseHealthy();

			const inboundTempScan =
				await this.filesystem.scanAndCleanupInboundTempFiles({
					olderThan: input.updatedBefore,
					limit: normalizePositiveInteger(input.inboundTempCleanupLimit, 1_000),
					cursor: this.inboundTempScanCursor,
				});
			this.inboundTempScanCursor = inboundTempScan.nextCursor ?? undefined;
			report.removedInboundTempFiles = inboundTempScan.items.length;
			await assertLeaseHealthy();

			const orphanedBefore = input.orphanedBefore ?? input.updatedBefore;
			const objectScan = await this.filesystem.scanObjects({
				limit: normalizePositiveInteger(input.objectScanLimit, 1_000),
				cursor: this.objectScanCursor,
			});
			this.objectScanCursor = objectScan.nextCursor ?? undefined;
			const objectBatch = objectScan.items;
			const objectKeys = objectBatch.map((object) => object.storageKey);
			const [trackedStorageKeys, deletedStorageKeys] = await Promise.all([
				this.metadata.listTrackedStorageKeys(objectKeys),
				this.metadata.listDeletedStorageKeys(objectKeys),
			]);
			const trackedKeys = new Set(trackedStorageKeys);
			const deletedKeys = new Set(deletedStorageKeys);
			const deletedObjects = objectBatch.filter((object) =>
				deletedKeys.has(object.storageKey),
			);
			await this.filesystem.deleteObjects(deletedObjects);
			report.removedDeletedObjects += deletedObjects.length;
			const orphanObjects = objectBatch.filter(
				(object) =>
					object.modifiedAt <= orphanedBefore &&
					!trackedKeys.has(object.storageKey) &&
					!deletedKeys.has(object.storageKey),
			);
			report.detectedOrphanObjects = orphanObjects.length;
			if (input.deleteOrphanObjects === true) {
				await this.filesystem.deleteObjects(orphanObjects);
				report.removedOrphanObjects = orphanObjects.length;
			}
			await assertLeaseHealthy();

			const now = input.now ?? new Date();
			const backlog = await this.metadata.getReconciliationBacklogMetrics();
			report.failedCount = backlog.failedCount;
			report.oldestPendingAgeMs = ageMs(now, backlog.oldestPendingAt);
			report.oldestDeletingAgeMs = ageMs(now, backlog.oldestDeletingAt);
			await assertLeaseHealthy();
			report.durationMs = Math.round(performance.now() - startedAt);
			await this.metadata.recordReconciliationResult?.(report);
			return report;
		} catch (error) {
			report.durationMs = Math.round(performance.now() - startedAt);
			await this.metadata
				.recordReconciliationFailure?.({
					error,
					durationMs: report.durationMs,
				})
				.catch(() => undefined);
			throw error;
		} finally {
			clearInterval(heartbeat);
			await leaseRenewal;
			await this.metadata.releaseReconciliationLease({
				owner: leaseOwner,
				token: lease.token,
			});
		}
	}

	private async finishDelete(deleting: Omit<ImageAssetDeleteRecord, 'status'>) {
		const eventId = normalizeDeleteEventId(deleting.eventId);
		const objects = [
			deleting.source,
			...deleting.variants.map((variant) => variant.object),
		];
		try {
			await this.filesystem.deleteObjects(objects);
			await this.metadata.completeDelete({
				assetId: deleting.assetId,
				eventId,
				cacheInvalidation: createImageCacheInvalidationEvent({
					eventId,
					clientServiceId: deleting.clientServiceId,
					path: toPublicCachePath(deleting.source.path),
					name: deleting.source.name,
					reason: 'delete',
					assetId: deleting.assetId,
				}),
			});
		} catch (error) {
			await this.metadata.recordDeleteFailure({
				assetId: deleting.assetId,
				eventId,
				reason: errorMessage(error),
			});
			throw error;
		}
	}
}

const toInspection = (staged: StagedImageObject): ImageObjectInspection => ({
	path: staged.path,
	name: staged.name,
	storageKey: staged.storageKey,
	checksum: staged.checksum,
	bytes: staged.size,
	format: staged.format,
	width: staged.width,
	height: staged.height,
});

const createUploadLifecycleEvent = (
	input: CreatePendingImageAssetInput,
	object: ImageObjectInspection,
	eventId: string,
	durationMs: number,
) =>
	createImageLifecycleEvent({
		eventId,
		eventType: ImageLifecycleEventType.UploadCompleted,
		clientServiceId: input.clientServiceId,
		clientServiceSlug: input.clientServiceSlug,
		requestId: input.requestId,
		traceId: input.traceId,
		imageId: input.externalImageId,
		path: input.logicalPath,
		name: object.name,
		originalName: input.originalName,
		imageKey: object.storageKey,
		format: normalizeImageFormat(object.format ?? object.name),
		inputBytes: input.inputBytes,
		outputBytes: object.bytes,
		durationMs,
		status: ImageLifecycleStatus.Success,
	});

const createUploadFailureLifecycleEvent = (
	input: CreatePendingImageAssetInput,
	eventId: string,
	error: unknown,
	durationMs: number,
) =>
	createImageLifecycleEvent({
		eventId,
		eventType: ImageLifecycleEventType.UploadFailed,
		clientServiceId: input.clientServiceId,
		clientServiceSlug: input.clientServiceSlug,
		requestId: input.requestId,
		traceId: input.traceId,
		imageId: input.externalImageId,
		path: input.logicalPath,
		name: input.name,
		originalName: input.originalName,
		imageKey: `${input.logicalPath}/${input.name}`,
		format: normalizeImageFormat(input.name),
		inputBytes: input.inputBytes,
		durationMs,
		status: ImageLifecycleStatus.Failed,
		errorCode: error instanceof Error ? error.name : 'IMAGE_UPLOAD_FAILED',
		errorMessage: errorMessage(error),
	});

const toUploadResult = (
	assetId: string,
	object: ImageObjectInspection,
	durationMs: number,
	completion: CompleteImageAssetUploadResult | void,
	fallbackEventId: string,
): ImageAssetUploadResult => ({
	assetId,
	eventId: completion?.eventId ?? fallbackEventId,
	variantStatus: completion?.variantStatus ?? 'NotConfigured',
	path: object.path,
	name: object.name,
	storageKey: object.storageKey,
	checksum: object.checksum,
	size: object.bytes,
	format: object.format ?? formatFromName(object.name),
	width: object.width,
	height: object.height,
	durationMs,
});

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const formatFromName = (name: string) => name.split('.').at(-1) ?? 'unknown';

const normalizeIdempotencyKey = (value: string) => {
	const normalized = value.trim();
	if (!normalized || normalized.length > 256) {
		throw new Error('image upload idempotency key is required');
	}
	return normalized;
};

const normalizeDeleteEventId = (value: string) => {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error('image delete eventId is required');
	}
	return normalized;
};

const toPublicCachePath = (path: string) =>
	path.endsWith('/image') ? path.slice(0, -'/image'.length) : path;

const normalizePositiveInteger = (
	value: number | undefined,
	fallback: number,
) =>
	Number.isInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;

const ageMs = (now: Date, value: Date | null) =>
	value ? Math.max(0, now.getTime() - value.getTime()) : null;
