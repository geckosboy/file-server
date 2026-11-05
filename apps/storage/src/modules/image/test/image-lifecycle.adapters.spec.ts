import { ImageAssetState } from '@prisma/client';
import { ImageAssetMetadataRepository } from '@file/database';
import { createImageVariantJobEvent } from '@file/telemetry-contracts/image-operations';
import {
	ImageAssetLifecycleMetadataAdapter,
	ImageCacheInvalidationAdapter,
	ImageVariantJobRepositoryAdapter,
} from '../image-lifecycle.adapters';
import { ImageCacheInvalidationPublisher } from '../image-cache-invalidation.publisher';
import { ImageLifecycleOutboxService } from '../image-lifecycle-outbox.service';
import { ImageLifecycleEvent } from '../image.lifecycle';
import { ImagePregenerationService } from '../image-pregeneration.service';
import { ImageVariantJobDispatcher } from '../image-variant-job.dispatcher';

const asset = {
	assetId: 'asset-1',
	clientServiceId: 'service-1',
	idempotencyKey: 'upload-1',
	sourceEventId: null,
	deleteEventId: null,
	externalImageId: 10,
	logicalPath: 'products/image',
	name: 'sample.png',
	originalName: 'sample.png',
	storageKey: 'products/image/sample.png',
	contentType: 'image/png',
	inputBytes: 100,
	bytes: null,
	checksum: null,
	width: null,
	height: null,
	format: null,
	status: ImageAssetState.Pending,
	failureReason: null,
	cacheVersion: 1,
	readyAt: null,
	deletingAt: null,
	deletedAt: null,
	failedAt: null,
	lastReconciledAt: null,
	createdAt: new Date('2026-07-10T00:00:00.000Z'),
	updatedAt: new Date('2026-07-10T00:00:00.000Z'),
};

const job = createImageVariantJobEvent({
	assetId: 'asset-1',
	clientServiceId: 'service-1',
	path: 'products/image',
	name: 'sample.png',
	sourceChecksum: 'checksum-1',
	width: 400,
	format: 'webp',
});

const inspection = {
	path: 'products/image',
	name: 'sample.png',
	storageKey: 'products/image/sample.png',
	checksum: 'checksum-1',
	bytes: 80,
	format: 'png',
	width: 10,
	height: 10,
};

describe('Image lifecycle storage adapters', () => {
	it('commits Ready + lifecycle outbox + jobs, then never awaits Kafka wakeups', async () => {
		const transaction = {};
		const repository = {
			findAssetById: jest.fn().mockResolvedValue(asset),
			completeUpload: jest.fn().mockImplementation(async (_input, callback) => {
				await callback(transaction, {
					...asset,
					status: ImageAssetState.Ready,
					checksum: inspection.checksum,
				});
				return asset;
			}),
			createPendingJobsWithinTransaction: jest.fn().mockResolvedValue([job]),
		};
		const neverPublishes = new Promise<void>(() => undefined);
		const outbox = {
			enqueueWithinTransaction: jest.fn().mockResolvedValue([]),
			publishPending: jest.fn().mockReturnValue(neverPublishes),
		};
		const dispatcher = { publishPersisted: jest.fn() };
		const pregeneration = {
			listActiveVariantSpecs: jest
				.fn()
				.mockResolvedValue([{ width: 400, format: 'webp' }]),
		};
		const adapter = new ImageAssetLifecycleMetadataAdapter(
			repository as unknown as ImageAssetMetadataRepository,
			outbox as unknown as ImageLifecycleOutboxService,
			pregeneration as unknown as ImagePregenerationService,
			dispatcher as unknown as ImageVariantJobDispatcher,
		);

		const result = await Promise.race([
			adapter.completeUpload({
				assetId: 'asset-1',
				object: inspection,
				format: 'png',
				width: 10,
				height: 10,
			}),
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error('request awaited Kafka')), 100),
			),
		]);

		expect(result).toEqual({
			eventId: expect.any(String),
			variantStatus: 'Pending',
		});
		expect(outbox.enqueueWithinTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ eventType: 'image.upload.completed' }),
		);
		expect(repository.createPendingJobsWithinTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ sourceChecksum: 'checksum-1' }),
		);
		expect(outbox.publishPending).toHaveBeenCalled();
		expect(dispatcher.publishPersisted).toHaveBeenCalledWith([job]);
	});

	it('Ready retry returns the persisted current variant state', async () => {
		const repository = {
			findAssetById: jest.fn().mockResolvedValue({
				...asset,
				status: ImageAssetState.Ready,
				sourceEventId: 'upload-event-1',
				checksum: 'checksum-1',
			}),
			completeUpload: jest.fn().mockResolvedValue(asset),
			getVariantStatus: jest.fn().mockResolvedValue('Ready'),
		};
		const adapter = new ImageAssetLifecycleMetadataAdapter(
			repository as unknown as ImageAssetMetadataRepository,
			{
				publishPending: jest.fn().mockResolvedValue(undefined),
			} as unknown as ImageLifecycleOutboxService,
			{
				listActiveVariantSpecs: jest.fn().mockResolvedValue([]),
			} as unknown as ImagePregenerationService,
			{ publishPersisted: jest.fn() } as unknown as ImageVariantJobDispatcher,
		);

		await expect(
			adapter.completeUpload({
				assetId: 'asset-1',
				object: inspection,
				format: 'png',
			}),
		).resolves.toEqual({
			eventId: 'upload-event-1',
			variantStatus: 'Ready',
		});
		expect(repository.getVariantStatus).toHaveBeenCalledWith('asset-1');
	});

	it('Ready repair creates missing jobs without a new lifecycle outbox row', async () => {
		const transaction = {};
		const repository = {
			findAssetById: jest.fn().mockResolvedValue({
				...asset,
				status: ImageAssetState.Ready,
				sourceEventId: 'backfill-event-1',
			}),
			repairReadyAssetMetadata: jest
				.fn()
				.mockImplementation(async (_input, callback) => {
					await callback(transaction, {
						...asset,
						status: ImageAssetState.Ready,
						checksum: 'checksum-1',
					});
				}),
			createPendingJobsWithinTransaction: jest.fn().mockResolvedValue([job]),
		};
		const outbox = {
			enqueueWithinTransaction: jest.fn(),
			publishPending: jest.fn().mockResolvedValue(undefined),
		};
		const dispatcher = { publishPersisted: jest.fn() };
		const adapter = new ImageAssetLifecycleMetadataAdapter(
			repository as unknown as ImageAssetMetadataRepository,
			outbox as unknown as ImageLifecycleOutboxService,
			{
				listActiveVariantSpecs: jest
					.fn()
					.mockResolvedValue([{ width: 400, format: 'webp' }]),
			} as unknown as ImagePregenerationService,
			dispatcher as unknown as ImageVariantJobDispatcher,
		);

		await adapter.repairReadyAsset({
			assetId: 'asset-1',
			object: inspection,
			format: 'png',
		});

		expect(outbox.enqueueWithinTransaction).not.toHaveBeenCalled();
		expect(repository.createPendingJobsWithinTransaction).toHaveBeenCalled();
		expect(dispatcher.publishPersisted).toHaveBeenCalledWith([job]);
	});

	it('keeps failure attempt event ids out of the eventual source completion identity', async () => {
		const transaction = {};
		const repository = {
			failAsset: jest
				.fn()
				.mockImplementation(async (_assetId, _reason, callback) => {
					await callback(transaction, asset);
				}),
		};
		const outbox = {
			enqueueWithinTransaction: jest.fn().mockResolvedValue([]),
			publishPending: jest.fn().mockResolvedValue(undefined),
		};
		const adapter = new ImageAssetLifecycleMetadataAdapter(
			repository as unknown as ImageAssetMetadataRepository,
			outbox as unknown as ImageLifecycleOutboxService,
			{} as ImagePregenerationService,
			{ publishPersisted: jest.fn() } as unknown as ImageVariantJobDispatcher,
		);
		const failure = {
			eventId: 'upload-attempt-failed-1',
			eventType: 'image.upload.failed',
		} as ImageLifecycleEvent;

		await adapter.failAsset({
			assetId: 'asset-1',
			reason: 'disk failed',
			lifecycleEvent: failure,
		});

		expect(repository.failAsset).toHaveBeenCalledWith(
			'asset-1',
			'disk failed',
			expect.any(Function),
		);
		expect(outbox.enqueueWithinTransaction).toHaveBeenCalledWith(
			transaction,
			failure,
		);
	});

	it('cache invalidation false result keeps delete retryable', async () => {
		const adapter = new ImageCacheInvalidationAdapter({
			publish: jest.fn().mockResolvedValue(false),
		} as unknown as ImageCacheInvalidationPublisher);

		await expect(
			adapter.invalidateAsset({
				assetId: 'asset-1',
				eventId: 'delete-event-1',
				clientServiceId: 'service-1',
				storageKeys: ['products/image/sample.png'],
			}),
		).rejects.toThrow(
			'cache invalidation publish failed for products/image/sample.png',
		);
	});

	it('persists delete lifecycle and cache invalidation before returning without Kafka', async () => {
		const transaction = {};
		const repository = {
			completeDelete: jest
				.fn()
				.mockImplementation(async (_assetId, callback) => {
					await callback(
						transaction,
						{ ...asset, status: ImageAssetState.Deleted },
						'delete-event-1',
					);
				}),
		};
		const neverPublishes = new Promise<void>(() => undefined);
		const outbox = {
			enqueueWithinTransaction: jest.fn().mockResolvedValue([]),
			enqueueCacheInvalidationWithinTransaction: jest
				.fn()
				.mockResolvedValue(undefined),
			publishPending: jest.fn().mockReturnValue(neverPublishes),
		};
		const adapter = new ImageAssetLifecycleMetadataAdapter(
			repository as unknown as ImageAssetMetadataRepository,
			outbox as unknown as ImageLifecycleOutboxService,
			{
				listActiveVariantSpecs: jest.fn(),
			} as unknown as ImagePregenerationService,
			{ publishPersisted: jest.fn() } as unknown as ImageVariantJobDispatcher,
		);

		await Promise.race([
			adapter.completeDelete({
				assetId: 'asset-1',
				eventId: 'delete-event-1',
				cacheInvalidation: {
					schemaVersion: 1,
					eventId: 'delete-event-1',
					eventType: 'image.cache.invalidated',
					occurredAt: new Date().toISOString(),
					clientServiceId: 'service-1',
					path: 'products',
					name: 'sample.png',
					reason: 'delete',
					assetId: 'asset-1',
				},
			}),
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error('delete awaited Kafka')), 100),
			),
		]);

		expect(outbox.enqueueWithinTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ eventId: 'delete-event-1' }),
		);
		expect(
			outbox.enqueueCacheInvalidationWithinTransaction,
		).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ eventId: 'delete-event-1' }),
		);
		expect(outbox.publishPending).toHaveBeenCalled();
	});

	it('distinguishes a missing legacy asset from authoritative Deleted metadata', async () => {
		const repository = {
			findAssetForDelete: jest
				.fn()
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					...asset,
					status: ImageAssetState.Deleted,
				}),
			beginDelete: jest.fn(),
		};
		const adapter = new ImageAssetLifecycleMetadataAdapter(
			repository as unknown as ImageAssetMetadataRepository,
			{} as ImageLifecycleOutboxService,
			{} as ImagePregenerationService,
			{} as ImageVariantJobDispatcher,
		);
		const input = {
			clientServiceId: 'service-1',
			path: 'products/image',
			name: 'sample.png',
		};

		await expect(adapter.beginDelete(input)).resolves.toBeNull();
		await expect(adapter.beginDelete(input)).resolves.toEqual({
			status: 'Deleted',
		});
		expect(repository.beginDelete).not.toHaveBeenCalled();
	});

	it('commits variant Ready and a stable invalidation outbox row together', async () => {
		const transaction = {};
		const repository = {
			completeJob: jest
				.fn()
				.mockImplementation(async (_job, _result, callback) => {
					await callback(transaction, {});
					return {};
				}),
		};
		const outbox = {
			enqueueCacheInvalidationWithinTransaction: jest
				.fn()
				.mockResolvedValue(undefined),
			publishPending: jest.fn().mockResolvedValue(undefined),
		};
		const adapter = new ImageVariantJobRepositoryAdapter(
			repository as unknown as ImageAssetMetadataRepository,
			outbox as unknown as ImageLifecycleOutboxService,
		);

		await expect(
			adapter.completeJob(job, {
				name: 'sample__w400.webp',
				storageKey: 'products/image/sample__w400.webp',
				inputBytes: 80,
				outputBytes: 40,
				checksum: 'variant-checksum',
			}),
		).resolves.toBe(true);

		expect(
			outbox.enqueueCacheInvalidationWithinTransaction,
		).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				eventId: `variant-ready:${job.jobKey}`,
				reason: 'variant-ready',
			}),
		);
	});

	it('reports a fenced variant result so the worker can remove its file', async () => {
		const adapter = new ImageVariantJobRepositoryAdapter(
			{
				completeJob: jest.fn().mockResolvedValue(null),
			} as unknown as ImageAssetMetadataRepository,
			{
				publishPending: jest.fn().mockResolvedValue(undefined),
			} as unknown as ImageLifecycleOutboxService,
		);

		await expect(
			adapter.completeJob(job, {
				name: 'sample__w400.webp',
				storageKey: 'products/image/sample__w400.webp',
				inputBytes: 80,
				outputBytes: 40,
				checksum: 'variant-checksum',
			}),
		).resolves.toBe(false);
	});
});
