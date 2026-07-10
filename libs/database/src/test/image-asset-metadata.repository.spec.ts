import {
	ImageAssetState,
	ImageVariantJobState,
	ImageVariantState,
	type ImageAsset,
} from '@prisma/client';
import {
	ImageAssetMetadataRepository,
	createImageVariantSpecKey,
} from '../image-asset-metadata.repository';
import type { PrismaService } from '../prisma.service';

const pendingAsset = (overrides: Partial<ImageAsset> = {}): ImageAsset =>
	({
		assetId: 'asset-1',
		clientServiceId: 'service-1',
		idempotencyKey: 'upload-1',
		sourceEventId: null,
		deleteEventId: null,
		externalImageId: null,
		logicalPath: 'products/image',
		name: 'sample.uuid.png',
		originalName: 'sample.png',
		storageKey: 'products/image/sample.uuid.png',
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
		...overrides,
	}) as ImageAsset;

const variantJobEvent = () =>
	({
		schemaVersion: 1,
		eventId: 'variant-job-1',
		eventType: 'image.variant.requested',
		occurredAt: '2026-07-10T00:00:00.000Z',
		jobKey: 'variant-job-1',
		assetId: 'asset-1',
		clientServiceId: 'service-1',
		path: 'products/image',
		name: 'sample.png',
		sourceChecksum: 'source-checksum',
		width: 100,
		format: 'webp',
	}) as const;

describe('ImageAssetMetadataRepository', () => {
	const originalWriteFlag = process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED;

	afterEach(() => {
		if (originalWriteFlag === undefined) {
			delete process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED;
		} else {
			process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED = originalWriteFlag;
		}
		jest.restoreAllMocks();
	});

	it('variant spec key is deterministic across format/checksum casing', () => {
		expect(
			createImageVariantSpecKey({
				width: 400,
				format: 'WEBP',
				sourceChecksum: 'ABCDEF',
			}),
		).toBe('w=400;h=auto;f=webp;s=abcdef');
		expect(
			createImageVariantSpecKey({
				width: 400,
				format: 'webp',
				sourceChecksum: 'different',
			}),
		).not.toBe('w=400;h=auto;f=webp;s=abcdef');
	});

	it('write compatibility flag can retain the legacy-only path', async () => {
		process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED = 'false';
		const upsert = jest.fn();
		const repository = new ImageAssetMetadataRepository({
			imageAsset: { upsert },
		} as unknown as PrismaService);

		await expect(
			repository.createPendingUpload({
				clientServiceId: 'service-1',
				idempotencyKey: 'upload-1',
				logicalPath: 'products/image',
				name: 'sample.uuid.png',
				originalName: 'sample.png',
				storageKey: 'products/image/sample.uuid.png',
				contentType: 'image/png',
			}),
		).resolves.toBeNull();
		expect(upsert).not.toHaveBeenCalled();
	});

	it('same upload idempotency key returns the stable asset identity', async () => {
		const asset = pendingAsset();
		const upsert = jest.fn().mockResolvedValue(asset);
		const repository = new ImageAssetMetadataRepository({
			imageAsset: { upsert },
		} as unknown as PrismaService);

		await expect(
			repository.createPendingUpload({
				clientServiceId: asset.clientServiceId,
				idempotencyKey: asset.idempotencyKey,
				logicalPath: asset.logicalPath,
				name: asset.name,
				originalName: asset.originalName,
				storageKey: asset.storageKey,
				contentType: asset.contentType,
				inputBytes: asset.inputBytes ?? undefined,
			}),
		).resolves.toMatchObject({ assetId: 'asset-1', status: 'Pending' });
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it.each([
		['originalName', { originalName: 'different.png' }],
		['contentType', { contentType: 'image/jpeg' }],
		['inputBytes', { inputBytes: 101 }],
		['externalImageId', { externalImageId: 22 }],
	] as const)(
		'rejects idempotency-key reuse with different %s metadata',
		async (_field, override) => {
			const asset = pendingAsset({ externalImageId: 21 });
			const repository = new ImageAssetMetadataRepository({
				imageAsset: { upsert: jest.fn().mockResolvedValue(asset) },
			} as unknown as PrismaService);

			await expect(
				repository.createPendingUpload({
					clientServiceId: asset.clientServiceId,
					idempotencyKey: asset.idempotencyKey,
					logicalPath: asset.logicalPath,
					name: asset.name,
					originalName: asset.originalName,
					storageKey: asset.storageKey,
					contentType: asset.contentType,
					inputBytes: asset.inputBytes ?? undefined,
					externalImageId: asset.externalImageId ?? undefined,
					...override,
				}),
			).rejects.toThrow('was reused for a different upload');
		},
	);

	it('Ready transition and lifecycle outbox callback share one transaction', async () => {
		const ready = pendingAsset({
			status: ImageAssetState.Ready,
			sourceEventId: 'upload-event-1',
			checksum: 'checksum-1',
		});
		const transaction = {
			imageAsset: {
				findUniqueOrThrow: jest
					.fn()
					.mockResolvedValueOnce(pendingAsset())
					.mockResolvedValueOnce(ready),
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			},
		};
		const prisma = {
			$transaction: jest.fn((work) => work(transaction)),
		};
		const repository = new ImageAssetMetadataRepository(
			prisma as unknown as PrismaService,
		);
		const enqueueOutbox = jest.fn().mockResolvedValue(undefined);

		const result = await repository.completeUpload(
			{
				assetId: 'asset-1',
				sourceEventId: 'upload-event-1',
				bytes: 80,
				checksum: 'checksum-1',
				format: 'png',
			},
			enqueueOutbox,
		);

		expect(result.status).toBe(ImageAssetState.Ready);
		expect(transaction.imageAsset.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					assetId: 'asset-1',
					status: ImageAssetState.Pending,
					updatedAt: pendingAsset().updatedAt,
				}),
				data: expect.objectContaining({
					status: ImageAssetState.Ready,
					checksum: 'checksum-1',
					readyAt: expect.any(Date),
				}),
			}),
		);
		expect(enqueueOutbox).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ assetId: 'asset-1' }),
		);
	});

	it('Ready retry reuses the identical source event without duplicate callback work', async () => {
		const readyAsset = pendingAsset({
			status: ImageAssetState.Ready,
			sourceEventId: 'upload-event-1',
			checksum: 'checksum-1',
		});
		const transaction = {
			imageAsset: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(readyAsset),
				updateMany: jest.fn(),
			},
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);
		const callback = jest.fn();

		await expect(
			repository.completeUpload(
				{
					assetId: 'asset-1',
					sourceEventId: 'upload-event-1',
					bytes: 80,
					checksum: 'checksum-1',
					format: 'png',
				},
				callback,
			),
		).resolves.toBe(readyAsset);
		expect(callback).not.toHaveBeenCalled();
		expect(transaction.imageAsset.updateMany).not.toHaveBeenCalled();
	});

	it('concurrent Ready retry converges to the persisted source event without duplicate work', async () => {
		const ready = pendingAsset({
			status: ImageAssetState.Ready,
			sourceEventId: 'upload-event-1',
		});
		const transaction = {
			imageAsset: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(ready),
				updateMany: jest.fn(),
			},
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);

		const callback = jest.fn();
		await expect(
			repository.completeUpload(
				{
					assetId: 'asset-1',
					sourceEventId: 'upload-event-2',
					bytes: 80,
					checksum: 'checksum-1',
					format: 'png',
				},
				callback,
			),
		).resolves.toBe(ready);
		expect(callback).not.toHaveBeenCalled();
		expect(transaction.imageAsset.updateMany).not.toHaveBeenCalled();
	});

	it('does not overwrite a concurrent delete while completing an upload', async () => {
		const deleting = pendingAsset({
			status: ImageAssetState.Deleting,
			deleteEventId: 'delete-event-1',
		});
		const transaction = {
			imageAsset: {
				findUniqueOrThrow: jest
					.fn()
					.mockResolvedValueOnce(pendingAsset())
					.mockResolvedValueOnce(deleting),
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
			},
		};
		const callback = jest.fn();
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);

		await expect(
			repository.completeUpload(
				{
					assetId: 'asset-1',
					sourceEventId: 'upload-event-1',
					bytes: 80,
					checksum: 'checksum-1',
					format: 'png',
				},
				callback,
			),
		).rejects.toThrow('cannot transition to Ready');
		expect(callback).not.toHaveBeenCalled();
	});

	it('does not let upload failure overwrite a concurrent Ready winner', async () => {
		const ready = pendingAsset({ status: ImageAssetState.Ready });
		const transaction = {
			imageAsset: {
				findUniqueOrThrow: jest
					.fn()
					.mockResolvedValueOnce(pendingAsset())
					.mockResolvedValueOnce(ready),
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
			},
		};
		const callback = jest.fn();
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);

		await expect(
			repository.failAsset('asset-1', new Error('disk failed'), callback),
		).resolves.toBe(ready);
		expect(callback).not.toHaveBeenCalled();
	});

	it('repairs a backfilled Ready source without emitting or rebinding an upload event', async () => {
		const backfilled = pendingAsset({
			status: ImageAssetState.Ready,
			sourceEventId: 'backfill-event-1',
			checksum: null,
		});
		const repaired = pendingAsset({
			status: ImageAssetState.Ready,
			sourceEventId: 'backfill-event-1',
			checksum: 'checksum-1',
			bytes: 80,
			format: 'png',
		});
		const transaction = {
			imageAsset: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(backfilled),
				update: jest.fn().mockResolvedValue(repaired),
			},
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);
		const ensureDerived = jest.fn().mockResolvedValue(undefined);

		await expect(
			repository.repairReadyAssetMetadata(
				{
					assetId: 'asset-1',
					bytes: 80,
					checksum: 'checksum-1',
					format: 'png',
				},
				ensureDerived,
			),
		).resolves.toBe(repaired);
		expect(transaction.imageAsset.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.not.objectContaining({ sourceEventId: expect.anything() }),
			}),
		);
		expect(ensureDerived).toHaveBeenCalledWith(transaction, repaired);
	});

	it('persists 0/1/20 variant specs with a constant bounded query shape', async () => {
		const run = async (count: number) => {
			const variants = Array.from({ length: count }, (_, index) => ({
				variantId: `variant-${index}`,
				assetId: 'asset-1',
				specKey: `spec-${index}`,
				storageKey: `products/image/sample.pending-${index}.webp`,
				width: index + 1,
				height: null,
				format: 'webp',
				sourceChecksum: 'checksum-1',
				bytes: null,
				checksum: null,
				status: ImageVariantState.Pending,
				failureReason: null,
				readyAt: null,
				deletingAt: null,
				deletedAt: null,
				failedAt: null,
				createdAt: new Date('2026-07-10T00:00:00.000Z'),
				updatedAt: new Date('2026-07-10T00:00:00.000Z'),
			}));
			const transaction = {
				imageAsset: {
					findUnique: jest.fn().mockResolvedValue({
						status: ImageAssetState.Ready,
						checksum: 'checksum-1',
					}),
				},
				imageVariant: {
					createMany: jest.fn().mockResolvedValue({ count }),
					findMany: jest.fn().mockResolvedValue(variants),
				},
				imageVariantJob: {
					createMany: jest.fn().mockResolvedValue({ count }),
					findMany: jest.fn().mockResolvedValue(
						variants.map((variant) => ({
							jobKey: `asset-1:${variant.width}:auto:webp:checksum-1`,
							variantId: variant.variantId,
							createdAt: variant.createdAt,
						})),
					),
				},
			};
			const repository = new ImageAssetMetadataRepository({} as PrismaService);
			await repository.createPendingJobsWithinTransaction(
				transaction as never,
				{
					assetId: 'asset-1',
					clientServiceId: 'service-1',
					logicalPath: 'products/image',
					name: 'sample.png',
					storageKey: 'products/image/sample.png',
					sourceChecksum: 'checksum-1',
					variants: variants.map(({ width }) => ({
						width: width!,
						format: 'webp',
					})),
				},
			);
			if (count > 0) {
				expect(
					transaction.imageVariant.createMany.mock.calls[0][0].data[0]
						.storageKey,
				).toBe('products/image/sample__w1_hauto.webp');
			}
			return Object.values(transaction).reduce(
				(total, delegate) =>
					total +
					Object.values(delegate).reduce(
						(countCalls, method) =>
							countCalls +
							(jest.isMockFunction(method) ? method.mock.calls.length : 0),
						0,
					),
				0,
			);
		};

		await expect(run(0)).resolves.toBeLessThanOrEqual(5);
		await expect(run(1)).resolves.toBe(5);
		await expect(run(20)).resolves.toBe(5);
	});

	it('delete begin atomically transitions asset and variants to Deleting', async () => {
		const deleting = pendingAsset({
			status: ImageAssetState.Deleting,
			deleteEventId: 'delete-event-1',
		});
		const transaction = {
			imageAsset: {
				findUnique: jest
					.fn()
					.mockResolvedValue(pendingAsset({ status: ImageAssetState.Ready })),
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				findUniqueOrThrow: jest.fn().mockResolvedValue(deleting),
			},
			imageVariant: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);

		await repository.beginDelete('asset-1', 'delete-event-1');

		expect(transaction.imageVariant.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ImageVariantState.Deleting,
					deletingAt: expect.any(Date),
				}),
			}),
		);
		expect(transaction.imageAsset.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: ImageAssetState.Ready,
					updatedAt: pendingAsset().updatedAt,
				}),
				data: expect.objectContaining({
					status: ImageAssetState.Deleting,
					deletingAt: expect.any(Date),
					deleteEventId: 'delete-event-1',
				}),
			}),
		);
	});

	it('rejects delete while an upload is Pending', async () => {
		const transaction = {
			imageAsset: { findUnique: jest.fn().mockResolvedValue(pendingAsset()) },
			imageVariant: { updateMany: jest.fn() },
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);

		await expect(
			repository.beginDelete('asset-1', 'delete-event-1'),
		).rejects.toThrow('cannot be deleted while Pending');
		expect(transaction.imageVariant.updateMany).not.toHaveBeenCalled();
	});

	it('reuses the winning delete event when concurrent delete CAS loses', async () => {
		const ready = pendingAsset({ status: ImageAssetState.Ready });
		const deleting = pendingAsset({
			status: ImageAssetState.Deleting,
			deleteEventId: 'delete-event-winner',
		});
		const transaction = {
			imageAsset: {
				findUnique: jest
					.fn()
					.mockResolvedValueOnce(ready)
					.mockResolvedValueOnce(deleting),
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
			},
			imageVariant: { updateMany: jest.fn() },
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);

		await expect(
			repository.beginDelete('asset-1', 'delete-event-loser'),
		).resolves.toBe(deleting);
		expect(transaction.imageVariant.updateMany).not.toHaveBeenCalled();
	});

	it('delete retries reuse the persisted event id through completion outbox', async () => {
		const transaction = {
			imageAsset: {
				findUniqueOrThrow: jest
					.fn()
					.mockResolvedValue({ deleteEventId: 'delete-event-stable' }),
				update: jest
					.fn()
					.mockImplementation(({ data }) =>
						Promise.resolve(
							pendingAsset({ ...data, status: ImageAssetState.Deleted }),
						),
					),
			},
			imageVariant: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
			imageVariantJob: {
				updateMany: jest.fn().mockResolvedValue({ count: 2 }),
			},
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);
		const enqueueOutbox = jest.fn().mockResolvedValue(undefined);

		await repository.completeDelete('asset-1', enqueueOutbox);

		expect(transaction.imageAsset.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					deleteEventId: 'delete-event-stable',
					status: ImageAssetState.Deleted,
				}),
			}),
		);
		expect(enqueueOutbox).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ assetId: 'asset-1' }),
			'delete-event-stable',
		);
	});

	it('fences variant completion after delete has changed asset or variant state', async () => {
		const transaction = {
			imageVariantJob: {
				findUniqueOrThrow: jest
					.fn()
					.mockResolvedValue({ variantId: 'variant-1' }),
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
			},
			imageVariant: {
				updateMany: jest.fn(),
				findUniqueOrThrow: jest.fn(),
			},
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
			imageVariantJob: {
				findUnique: jest.fn().mockResolvedValue({
					status: ImageVariantJobState.Cancelled,
					asset: { status: ImageAssetState.Deleted },
					variant: { status: ImageVariantState.Deleted },
				}),
			},
		} as unknown as PrismaService);
		const event = variantJobEvent();

		await expect(
			repository.completeJob(event, {
				name: 'sample__w100.webp',
				storageKey: 'products/image/sample__w100.webp',
				inputBytes: 100,
				outputBytes: 50,
				checksum: 'variant-checksum',
			}),
		).resolves.toBeNull();
		expect(transaction.imageVariantJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: ImageVariantJobState.Processing,
					asset: { status: ImageAssetState.Ready },
				}),
			}),
		);
		expect(transaction.imageVariant.updateMany).not.toHaveBeenCalled();
	});

	it('treats a concurrent Ready winner as committed instead of deleting its file', async () => {
		const readyVariant = {
			variantId: 'variant-1',
			status: ImageVariantState.Ready,
		};
		const transaction = {
			imageVariantJob: {
				findUniqueOrThrow: jest
					.fn()
					.mockResolvedValue({ variantId: 'variant-1' }),
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
			},
			imageVariant: {
				updateMany: jest.fn(),
				findUniqueOrThrow: jest.fn(),
			},
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
			imageVariantJob: {
				findUnique: jest.fn().mockResolvedValue({
					status: ImageVariantJobState.Completed,
					asset: { status: ImageAssetState.Ready },
					variant: readyVariant,
				}),
			},
		} as unknown as PrismaService);

		await expect(
			repository.completeJob(variantJobEvent(), {
				name: 'sample__w100.webp',
				storageKey: 'products/image/sample__w100.webp',
				inputBytes: 100,
				outputBytes: 50,
				checksum: 'variant-checksum',
			}),
		).resolves.toEqual(readyVariant);
	});

	it.each([
		{
			name: 'cancelled delete job',
			job: {
				status: ImageVariantJobState.Cancelled,
				attempts: 0,
				asset: { status: ImageAssetState.Deleted },
				variant: { status: ImageVariantState.Deleted },
			},
		},
		{
			name: 'terminal failed job',
			job: {
				status: ImageVariantJobState.Failed,
				attempts: 3,
				asset: { status: ImageAssetState.Ready },
				variant: { status: ImageVariantState.Failed },
			},
		},
	])('acknowledges $name as a terminal discard', async ({ job }) => {
		const updateMany = jest.fn();
		const repository = new ImageAssetMetadataRepository({
			imageVariantJob: {
				findUnique: jest.fn().mockResolvedValue(job),
				updateMany,
			},
		} as unknown as PrismaService);

		await expect(repository.claimJob(variantJobEvent())).resolves.toEqual({
			result: 'discarded',
			event: variantJobEvent(),
		});
		expect(updateMany).not.toHaveBeenCalled();
	});

	it('requeues bounded variant failures and keeps terminal failure published', async () => {
		const originalMaxAttempts = process.env.IMAGE_VARIANT_JOB_MAX_ATTEMPTS;
		process.env.IMAGE_VARIANT_JOB_MAX_ATTEMPTS = '3';
		const event = variantJobEvent();
		const run = async (attempts: number) => {
			const transaction = {
				imageVariantJob: {
					findUniqueOrThrow: jest
						.fn()
						.mockResolvedValueOnce({ variantId: 'variant-1', attempts })
						.mockResolvedValueOnce({ attempts: attempts + 1 }),
					updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				},
				imageVariant: {
					updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				},
			};
			const repository = new ImageAssetMetadataRepository({
				$transaction: jest.fn((work) => work(transaction)),
			} as unknown as PrismaService);
			await repository.failJob(event, new Error('sharp failed'));
			return transaction.imageVariantJob.updateMany.mock.calls[0][0].data;
		};

		try {
			await expect(run(0)).resolves.toEqual(
				expect.objectContaining({
					attempts: 1,
					publishedAt: null,
					nextPublishAt: expect.any(Date),
				}),
			);
			const terminal = await run(2);
			expect(terminal).toEqual(expect.objectContaining({ attempts: 3 }));
			expect(terminal).not.toHaveProperty('publishedAt');
		} finally {
			if (originalMaxAttempts === undefined) {
				delete process.env.IMAGE_VARIANT_JOB_MAX_ATTEMPTS;
			} else {
				process.env.IMAGE_VARIANT_JOB_MAX_ATTEMPTS = originalMaxAttempts;
			}
		}
	});

	it('fences variant repair against delete and requeues the canonical job', async () => {
		const updatedAt = new Date('2026-07-10T00:00:00.000Z');
		const existing = {
			variantId: 'variant-1',
			assetId: 'asset-1',
			width: 100,
			height: null,
			format: 'webp',
			sourceChecksum: 'stale-checksum',
			status: ImageVariantState.Ready,
			updatedAt,
			asset: {
				status: ImageAssetState.Ready,
				checksum: 'current-checksum',
			},
		};
		const repaired = {
			...existing,
			status: ImageVariantState.Failed,
			sourceChecksum: 'current-checksum',
		};
		const jobUpdateMany = jest
			.fn()
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 1 });
		const transaction = {
			imageVariant: {
				findUniqueOrThrow: jest
					.fn()
					.mockResolvedValueOnce(existing)
					.mockResolvedValueOnce(repaired),
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			},
			imageVariantJob: {
				updateMany: jobUpdateMany,
				createMany: jest.fn().mockResolvedValue({ count: 1 }),
			},
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);

		await expect(
			repository.failVariant(
				'variant-1',
				'reconciliation: variant source checksum is stale',
			),
		).resolves.toBe(repaired);
		expect(transaction.imageVariant.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: ImageVariantState.Ready,
					updatedAt,
					asset: { status: ImageAssetState.Ready },
				}),
				data: expect.objectContaining({
					status: ImageVariantState.Failed,
					sourceChecksum: 'current-checksum',
					specKey: 'w=100;h=auto;f=webp;s=current-checksum',
				}),
			}),
		);
		expect(jobUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: {
					jobKey: 'asset-1:100:auto:webp:current-checksum',
					assetId: 'asset-1',
					variantId: 'variant-1',
				},
				data: expect.objectContaining({
					status: ImageVariantJobState.Failed,
					attempts: 0,
					publishedAt: null,
				}),
			}),
		);
	});

	it('does not resurrect a variant after delete wins', async () => {
		const deleted = {
			variantId: 'variant-1',
			status: ImageVariantState.Deleted,
			asset: { status: ImageAssetState.Deleted },
		};
		const updateMany = jest.fn();
		const transaction = {
			imageVariant: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(deleted),
				updateMany,
			},
			imageVariantJob: { updateMany: jest.fn(), createMany: jest.fn() },
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);

		await expect(repository.failVariant('variant-1', 'missing')).resolves.toBe(
			deleted,
		);
		expect(updateMany).not.toHaveBeenCalled();
		expect(transaction.imageVariantJob.updateMany).not.toHaveBeenCalled();
	});

	it('reconciliation candidate and tracked-key queries remain bounded', async () => {
		const assetFindMany = jest
			.fn()
			.mockResolvedValue([{ storageKey: 'products/image/a.png' }]);
		const variantFindMany = jest.fn().mockResolvedValue([]);
		const repository = new ImageAssetMetadataRepository({
			imageAsset: { findMany: assetFindMany },
			imageVariant: { findMany: variantFindMany },
		} as unknown as PrismaService);
		const cutoff = new Date('2026-07-10T00:00:00.000Z');

		await repository.listReconciliationCandidates(cutoff, 25);
		await expect(
			repository.listTrackedStorageKeys([
				'products/image/a.png',
				'products/image/a.png',
				'products/image/orphan.png',
			]),
		).resolves.toEqual(['products/image/a.png']);

		expect(assetFindMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				take: 25,
				where: expect.objectContaining({
					status: {
						in: [ImageAssetState.Pending, ImageAssetState.Deleting],
					},
				}),
			}),
		);
		expect(assetFindMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				take: 24,
				where: expect.objectContaining({
					status: ImageAssetState.Ready,
					lastReconciledAt: null,
				}),
			}),
		);
		expect(assetFindMany).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				take: 23,
				where: expect.objectContaining({
					status: ImageAssetState.Ready,
					lastReconciledAt: { lte: cutoff },
				}),
			}),
		);
		expect(assetFindMany).toHaveBeenNthCalledWith(
			4,
			expect.objectContaining({
				where: expect.objectContaining({
					storageKey: {
						in: ['products/image/a.png', 'products/image/orphan.png'],
					},
				}),
			}),
		);
	});

	it('queries every tracked key safely when an object scan exceeds 10k', async () => {
		const keys = Array.from(
			{ length: 10_001 },
			(_, index) => `products/image/${index}.png`,
		);
		const assetFindMany = jest
			.fn()
			.mockImplementation(({ where }) =>
				Promise.resolve(
					where.storageKey.in.map((storageKey: string) => ({ storageKey })),
				),
			);
		const variantFindMany = jest.fn().mockResolvedValue([]);
		const repository = new ImageAssetMetadataRepository({
			imageAsset: { findMany: assetFindMany },
			imageVariant: { findMany: variantFindMany },
		} as unknown as PrismaService);

		await expect(repository.listTrackedStorageKeys(keys)).resolves.toHaveLength(
			keys.length,
		);
		expect(assetFindMany).toHaveBeenCalledTimes(11);
		expect(variantFindMany).toHaveBeenCalledTimes(11);
		for (const [query] of assetFindMany.mock.calls) {
			expect(query.where.storageKey.in.length).toBeLessThanOrEqual(1_000);
		}
	});

	it('returns recent Deleted source and variant keys for unconditional reconciliation cleanup', async () => {
		const assetFindMany = jest
			.fn()
			.mockResolvedValue([{ storageKey: 'products/image/source.png' }]);
		const variantFindMany = jest
			.fn()
			.mockResolvedValue([
				{ storageKey: 'products/image/source__w100_hauto.webp' },
			]);
		const repository = new ImageAssetMetadataRepository({
			imageAsset: { findMany: assetFindMany },
			imageVariant: { findMany: variantFindMany },
		} as unknown as PrismaService);

		await expect(
			repository.listRecentlyDeletedStorageKeys(25),
		).resolves.toEqual([
			'products/image/source.png',
			'products/image/source__w100_hauto.webp',
		]);
		expect(assetFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { status: ImageAssetState.Deleted },
				take: 25,
			}),
		);
		expect(variantFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { status: ImageVariantState.Deleted },
				take: 25,
			}),
		);
	});

	it('reconciliation lease applies transaction-local lock timeout', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			$queryRaw: jest.fn().mockResolvedValue([{ token: 'lease-token' }]),
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);

		await expect(
			repository.tryAcquireReconciliationLease('worker-2', 30_000, 750),
		).resolves.toBe('lease-token');
		expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
		expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
	});

	it('reconciliation lease renewal uses a safe default lock timeout', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			imageReconciliationLease: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			},
		};
		const repository = new ImageAssetMetadataRepository({
			$transaction: jest.fn((work) => work(transaction)),
		} as unknown as PrismaService);

		await expect(
			repository.renewReconciliationLease('worker-2', 'token-1', 30_000),
		).resolves.toEqual({ count: 1 });
		expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
	});
});
