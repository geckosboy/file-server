import { copyFile, mkdir, rm, stat, utimes, writeFile } from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import { Root } from 'src/enum';
import {
	ImageAssetLifecycleMetadataPort,
	ImageAssetLifecycleService,
	ImageAssetReconciliationRecord,
	ImageCacheInvalidationPort,
} from '.././image-asset-lifecycle.service';
import { ImageFilesystemStore } from '.././image-filesystem.store';
import {
	ImageLifecycleFailpoint,
	ImageLifecycleFailpointService,
} from '../image-lifecycle.failpoints';
import { SharpStrategy } from '.././strategies/sharp';

class CopyStrategy extends SharpStrategy {
	async compressAndSave(info: {
		from: string;
		to: string;
	}): Promise<sharp.OutputInfo> {
		await copyFile(info.from, info.to);
		const result = await stat(info.to);
		return {
			format: 'png',
			size: result.size,
			width: 2,
			height: 3,
			channels: 4 as const,
			premultiplied: false,
		};
	}
}

type MetadataMock = jest.Mocked<ImageAssetLifecycleMetadataPort>;
type CacheInvalidationMock = jest.Mocked<ImageCacheInvalidationPort>;

describe('이미지 asset 파일시스템 수명주기', () => {
	const assetsRoot = path.resolve(Root, 'assets');
	const tempRoot = path.resolve(Root, 'temp');
	const fixtureRoot = path.resolve(assetsRoot, 'image-asset-lifecycle');
	const sourcePath = path.resolve(tempRoot, 'image-asset-lifecycle-source.png');
	let filesystem: ImageFilesystemStore;
	let metadata: MetadataMock;
	let cacheInvalidation: CacheInvalidationMock;
	let service: ImageAssetLifecycleService;
	let strategy: CopyStrategy;

	beforeEach(async () => {
		filesystem = new ImageFilesystemStore();
		metadata = createMetadataMock();
		cacheInvalidation = {
			invalidateAsset: jest.fn().mockResolvedValue(undefined),
		};
		service = new ImageAssetLifecycleService(
			filesystem,
			metadata,
			cacheInvalidation,
		);
		strategy = new CopyStrategy();
		await rm(fixtureRoot, { recursive: true, force: true });
		await mkdir(tempRoot, { recursive: true });
		await writeFile(sourcePath, 'lifecycle-source');
	});

	afterEach(async () => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		await rm(fixtureRoot, { recursive: true, force: true });
		await rm(sourcePath, { force: true });
	});

	it('Pending metadata를 먼저 만들고 canonical 파일 승격 뒤 Ready+outbox 경계를 완료한다', async () => {
		const order: string[] = [];
		metadata.createPendingUpload.mockImplementation(async () => {
			order.push('pending');
			return pendingAsset();
		});
		metadata.completeUpload.mockImplementation(async () => {
			order.push('ready');
		});
		const stageSpy = jest
			.spyOn(filesystem, 'stageImage')
			.mockImplementation(async (...args) => {
				order.push('stage');
				return Reflect.apply(
					ImageFilesystemStore.prototype.stageImage,
					filesystem,
					args,
				);
			});
		const promoteSpy = jest
			.spyOn(filesystem, 'promoteImage')
			.mockImplementation(async (...args) => {
				order.push('promote');
				return Reflect.apply(
					ImageFilesystemStore.prototype.promoteImage,
					filesystem,
					args,
				);
			});

		const result = await service.upload(strategy, uploadInput());

		expect(order).toEqual(['pending', 'stage', 'promote', 'ready']);
		expect(stageSpy).toHaveBeenCalled();
		expect(promoteSpy).toHaveBeenCalled();
		expect(metadata.completeUpload).toHaveBeenCalledWith(
			expect.objectContaining({
				assetId: 'asset-1',
				object: expect.objectContaining({
					storageKey: 'image-asset-lifecycle/image/asset.png',
					checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
					bytes: Buffer.byteLength('lifecycle-source'),
				}),
				format: 'png',
				width: 2,
				height: 3,
				lifecycleEvent: expect.objectContaining({
					eventType: 'image.upload.completed',
					eventId: expect.any(String),
				}),
			}),
		);
		expect(result.assetId).toBe('asset-1');
		await expect(filesystem.hasObject(pendingAsset().source)).resolves.toBe(
			true,
		);
	});

	it('disk write 실패는 canonical 파일을 노출하지 않고 asset을 Failed로 만든다', async () => {
		jest
			.spyOn(filesystem, 'stageImage')
			.mockRejectedValue(new Error('injected disk failure'));

		await expect(service.upload(strategy, uploadInput())).rejects.toThrow(
			'injected disk failure',
		);

		expect(metadata.failAsset).toHaveBeenCalledWith({
			assetId: 'asset-1',
			reason: 'injected disk failure',
			lifecycleEvent: expect.objectContaining({
				eventType: 'image.upload.failed',
				eventId: expect.any(String),
				errorMessage: 'injected disk failure',
			}),
		});
		expect(metadata.completeUpload).not.toHaveBeenCalled();
		await expect(filesystem.hasObject(pendingAsset().source)).resolves.toBe(
			false,
		);
	});

	it('checksum 단계 실패는 stage를 정리하고 재시도 가능한 Failed metadata를 남긴다', async () => {
		const failpoints = {
			trigger: jest.fn((failpoint: ImageLifecycleFailpoint) => {
				if (failpoint === ImageLifecycleFailpoint.BeforeStageChecksum) {
					throw new Error('injected checksum failure');
				}
			}),
		};
		const failingFilesystem = new ImageFilesystemStore(
			failpoints as unknown as ImageLifecycleFailpointService,
		);
		const failingService = new ImageAssetLifecycleService(
			failingFilesystem,
			metadata,
			cacheInvalidation,
		);

		await expect(
			failingService.upload(strategy, uploadInput()),
		).rejects.toThrow('injected checksum failure');
		expect(metadata.failAsset).toHaveBeenCalledWith(
			expect.objectContaining({
				assetId: 'asset-1',
				reason: 'injected checksum failure',
			}),
		);
		await expect(
			failingFilesystem.hasObject(pendingAsset().source),
		).resolves.toBe(false);
	});

	it('Pending metadata 생성 실패는 filesystem write를 시작하지 않는다', async () => {
		metadata.createPendingUpload.mockRejectedValue(
			new Error('injected metadata create failure'),
		);
		const stage = jest.spyOn(filesystem, 'stageImage');

		await expect(service.upload(strategy, uploadInput())).rejects.toThrow(
			'injected metadata create failure',
		);

		expect(stage).not.toHaveBeenCalled();
		expect(metadata.failAsset).not.toHaveBeenCalled();
	});

	it('atomic rename 실패는 stage를 정리하고 retry 가능한 Failed metadata를 남긴다', async () => {
		jest
			.spyOn(filesystem, 'promoteImage')
			.mockRejectedValue(new Error('injected rename failure'));
		const discard = jest.spyOn(filesystem, 'discardStage');

		await expect(service.upload(strategy, uploadInput())).rejects.toThrow(
			'injected rename failure',
		);

		expect(discard).toHaveBeenCalledTimes(1);
		expect(metadata.failAsset).toHaveBeenCalledWith(
			expect.objectContaining({
				assetId: 'asset-1',
				reason: 'injected rename failure',
			}),
		);
	});

	it('Ready+outbox transaction 실패는 durable 파일과 Pending metadata를 reconciliation용으로 유지한다', async () => {
		metadata.completeUpload.mockRejectedValue(
			new Error('injected metadata transaction failure'),
		);

		await expect(service.upload(strategy, uploadInput())).rejects.toThrow(
			'injected metadata transaction failure',
		);

		expect(metadata.failAsset).not.toHaveBeenCalled();
		await expect(filesystem.hasObject(pendingAsset().source)).resolves.toBe(
			true,
		);
	});

	it('Deleted/Deleting tombstone retry는 filesystem write를 시작하지 않는다', async () => {
		metadata.createPendingUpload.mockResolvedValue({
			...pendingAsset(),
			status: 'Deleted',
		});
		const stage = jest.spyOn(filesystem, 'stageImage');

		await expect(service.upload(strategy, uploadInput())).rejects.toThrow(
			'is deleting or already deleted',
		);
		expect(stage).not.toHaveBeenCalled();
		expect(metadata.failAsset).not.toHaveBeenCalled();
	});

	it('promote 직후 delete가 이기면 fenced upload가 canonical 파일을 보상 삭제한다', async () => {
		metadata.createPendingUpload.mockResolvedValue({
			...pendingAsset(),
			status: 'Failed',
		});
		metadata.completeUpload.mockRejectedValue(
			new Error('asset cannot transition to Ready'),
		);
		metadata.getAssetStatus.mockResolvedValue('Deleting');

		await expect(service.upload(strategy, uploadInput())).rejects.toThrow(
			'asset cannot transition to Ready',
		);
		await expect(filesystem.hasObject(pendingAsset().source)).resolves.toBe(
			false,
		);
		expect(metadata.failAsset).not.toHaveBeenCalled();
	});

	it('같은 idempotency key 재시도는 같은 asset/storage key를 재사용한다', async () => {
		const first = await service.upload(strategy, uploadInput());
		const retried = await service.upload(strategy, uploadInput());

		expect(metadata.createPendingUpload).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ idempotencyKey: 'upload-request-1' }),
		);
		expect(metadata.createPendingUpload).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ idempotencyKey: 'upload-request-1' }),
		);
		expect(first.assetId).toBe('asset-1');
		expect(retried.assetId).toBe('asset-1');
		expect(retried.storageKey).toBe(first.storageKey);
	});

	it('빈 idempotency key는 Pending metadata 생성 전에 거부한다', async () => {
		await expect(
			service.upload(strategy, { ...uploadInput(), idempotencyKey: '   ' }),
		).rejects.toThrow('image upload idempotency key is required');
		expect(metadata.createPendingUpload).not.toHaveBeenCalled();
	});

	it('delete 재시도는 원본/variant와 durable cache invalidation을 멱등하게 완료한다', async () => {
		const directory = path.resolve(fixtureRoot, 'image');
		await mkdir(directory, { recursive: true });
		await writeFile(path.resolve(directory, 'asset.png'), 'source');
		await writeFile(path.resolve(directory, 'asset__w4_h4.webp'), 'variant');
		metadata.beginDelete
			.mockResolvedValueOnce(deletingAsset())
			.mockResolvedValueOnce({ status: 'Deleted' });

		await expect(
			service.delete({
				clientServiceId: 'service-1',
				path: 'image-asset-lifecycle/image',
				name: 'asset.png',
			}),
		).resolves.toEqual({
			alreadyDeleted: false,
			eventId: 'delete-event-1',
		});
		await expect(
			service.delete({
				clientServiceId: 'service-1',
				path: 'image-asset-lifecycle/image',
				name: 'asset.png',
			}),
		).resolves.toEqual({ alreadyDeleted: true });

		expect(cacheInvalidation.invalidateAsset).not.toHaveBeenCalled();
		expect(metadata.completeDelete).toHaveBeenCalledWith({
			assetId: 'asset-1',
			eventId: 'delete-event-1',
			cacheInvalidation: expect.objectContaining({
				eventId: 'delete-event-1',
				clientServiceId: 'service-1',
				path: 'image-asset-lifecycle',
				name: 'asset.png',
				reason: 'delete',
				assetId: 'asset-1',
			}),
		});
		expect(metadata.completeDelete).toHaveBeenCalledTimes(1);
		expect(metadata.recordDeleteFailure).not.toHaveBeenCalled();
	});

	it('delete는 metadata 미존재와 authoritative Deleted를 구분한다', async () => {
		metadata.beginDelete
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ status: 'Deleted' });

		await expect(
			service.delete({
				clientServiceId: 'service-1',
				path: 'image-asset-lifecycle/image',
				name: 'missing.png',
			}),
		).resolves.toEqual({ alreadyDeleted: true, metadataMissing: true });
		await expect(
			service.delete({
				clientServiceId: 'service-1',
				path: 'image-asset-lifecycle/image',
				name: 'deleted.png',
			}),
		).resolves.toEqual({ alreadyDeleted: true });
	});

	it('delete transaction 실패는 Deleting을 유지하고 다음 reconciliation에서 완료한다', async () => {
		metadata.completeDelete
			.mockRejectedValueOnce(new Error('delete transaction unavailable'))
			.mockResolvedValueOnce(undefined);
		metadata.beginDelete.mockResolvedValue(deletingAsset());

		await expect(
			service.delete({
				clientServiceId: 'service-1',
				path: 'image-asset-lifecycle/image',
				name: 'asset.png',
			}),
		).rejects.toThrow('delete transaction unavailable');
		expect(metadata.recordDeleteFailure).toHaveBeenCalledWith({
			assetId: 'asset-1',
			eventId: 'delete-event-1',
			reason: 'delete transaction unavailable',
		});

		metadata.listReconciliationCandidates.mockResolvedValue([
			deletingAsset({ updatedAt: new Date('2026-01-01T00:00:00.000Z') }),
		]);
		const report = await service.reconcile({
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
		});

		expect(report.completedDeletes).toBe(1);
		expect(metadata.completeDelete).toHaveBeenLastCalledWith(
			expect.objectContaining({
				assetId: 'asset-1',
				eventId: 'delete-event-1',
				cacheInvalidation: expect.objectContaining({
					eventId: 'delete-event-1',
				}),
			}),
		);
	});

	it('Pending/Ready/variant/orphan/stage 장애 상태를 한 번의 reconciliation으로 수렴한다', async () => {
		const directory = path.resolve(fixtureRoot, 'image');
		await mkdir(path.resolve(directory, '.staging'), { recursive: true });
		await writeFile(path.resolve(directory, 'pending-present.png'), 'pending');
		await writeFile(path.resolve(directory, 'ready-present.png'), 'ready');
		await writeFile(path.resolve(directory, 'orphan.png'), 'orphan');
		const stagePath = path.resolve(directory, '.staging', 'stale.stage');
		await writeFile(stagePath, 'stage');
		const stale = new Date('2026-01-01T00:00:00.000Z');
		await Promise.all([
			utimes(path.resolve(directory, 'orphan.png'), stale, stale),
			utimes(stagePath, stale, stale),
		]);
		metadata.listReconciliationCandidates.mockResolvedValue([
			reconciliationAsset('pending-present', 'Pending'),
			reconciliationAsset('pending-missing', 'Pending'),
			reconciliationAsset('ready-missing', 'Ready'),
			{
				...reconciliationAsset('ready-present', 'Ready'),
				variants: [
					{
						variantId: 'variant-missing',
						status: 'Ready',
						object: {
							path: 'image-asset-lifecycle/image',
							name: 'ready-present__w4_h4.webp',
						},
					},
				],
			},
		]);
		metadata.listTrackedStorageKeys.mockResolvedValue([
			'image-asset-lifecycle/image/pending-present.png',
			'image-asset-lifecycle/image/ready-present.png',
		]);
		metadata.getReconciliationBacklogMetrics.mockResolvedValue({
			failedCount: 2,
			oldestPendingAt: new Date('2026-01-01T00:00:00.000Z'),
			oldestDeletingAt: new Date('2026-01-01T00:02:00.000Z'),
		});

		const report = await service.reconcile({
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
			now: new Date('2026-01-01T00:05:00.000Z'),
			deleteOrphanObjects: true,
		});

		expect(report).toEqual({
			leaseAcquired: true,
			checkedAssets: 4,
			recoveredPendingAssets: 1,
			failedAssets: 2,
			failedVariants: 1,
			completedDeletes: 0,
			detectedOrphanObjects: 1,
			removedOrphanObjects: 1,
			removedDeletedObjects: 0,
			removedStagedObjects: 1,
			removedInboundTempFiles: 0,
			errors: 0,
			failedCount: 2,
			oldestPendingAgeMs: 5 * 60_000,
			oldestDeletingAgeMs: 3 * 60_000,
			durationMs: expect.any(Number),
		});
		expect(metadata.completeUpload).toHaveBeenCalledWith(
			expect.objectContaining({ assetId: 'asset-pending-present' }),
		);
		expect(metadata.repairReadyAsset).toHaveBeenCalledWith(
			expect.objectContaining({
				assetId: 'asset-ready-present',
				object: expect.objectContaining({
					checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
				}),
			}),
		);
		expect(metadata.failAsset).toHaveBeenCalledTimes(2);
		expect(metadata.failVariant).toHaveBeenCalledWith({
			variantId: 'variant-missing',
			reason: 'reconciliation: ready variant object is missing',
		});
		await expect(
			stat(path.resolve(directory, 'orphan.png')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		expect(metadata.releaseReconciliationLease).toHaveBeenCalledWith({
			owner: `storage-${process.pid}`,
			token: 'lease-1',
		});
	});

	it('다른 프로세스가 DB lease를 보유하면 filesystem scan을 시작하지 않는다', async () => {
		metadata.tryAcquireReconciliationLease.mockResolvedValue(null);
		const listSpy = jest.spyOn(filesystem, 'listObjects');

		const report = await service.reconcile({
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
		});

		expect(report.leaseAcquired).toBe(false);
		expect(metadata.listReconciliationCandidates).not.toHaveBeenCalled();
		expect(listSpy).not.toHaveBeenCalled();
		expect(metadata.releaseReconciliationLease).not.toHaveBeenCalled();
	});

	it('backfill 전 기본 모드에서는 metadata 없는 legacy object를 report만 하고 보존한다', async () => {
		const directory = path.resolve(fixtureRoot, 'image');
		const legacyPath = path.resolve(directory, 'legacy.png');
		await mkdir(directory, { recursive: true });
		await writeFile(legacyPath, 'legacy');
		const stale = new Date('2026-01-01T00:00:00.000Z');
		await utimes(legacyPath, stale, stale);
		metadata.listTrackedStorageKeys.mockResolvedValue([]);

		const report = await service.reconcile({
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
		});

		expect(report.detectedOrphanObjects).toBe(1);
		expect(report.removedOrphanObjects).toBe(0);
		await expect(stat(legacyPath)).resolves.toBeDefined();
	});

	it('Deleted metadata에 연결된 늦은 variant 파일은 orphan delete flag와 무관하게 정리한다', async () => {
		const directory = path.resolve(fixtureRoot, 'image');
		const resurrected = path.resolve(directory, 'deleted__w4_h4.webp');
		await mkdir(directory, { recursive: true });
		await writeFile(resurrected, 'late-worker-output');
		metadata.listRecentlyDeletedObjects.mockResolvedValue([
			{
				path: 'image-asset-lifecycle/image',
				name: 'deleted__w4_h4.webp',
			},
		]);

		const report = await service.reconcile({
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
			deleteOrphanObjects: false,
		});

		expect(report.removedDeletedObjects).toBe(1);
		await expect(stat(resurrected)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('recent top-N 밖 Deleted 파일도 cursor object scan으로 진행하며 정리한다', async () => {
		const deletedObject = {
			path: 'image-asset-lifecycle/image',
			name: 'older-deleted.webp',
			storageKey: 'image-asset-lifecycle/image/older-deleted.webp',
			modifiedAt: new Date('2026-01-01T00:00:00.000Z'),
			bytes: 1,
		};
		const directory = path.resolve(fixtureRoot, 'image');
		await mkdir(directory, { recursive: true });
		await writeFile(path.resolve(directory, deletedObject.name), 'late-output');
		jest.spyOn(filesystem, 'scanObjects').mockResolvedValue({
			items: [deletedObject],
			nextCursor: deletedObject.storageKey,
		});
		metadata.listTrackedStorageKeys.mockResolvedValue([]);
		metadata.listDeletedStorageKeys.mockResolvedValue([
			deletedObject.storageKey,
		]);

		const report = await service.reconcile({
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
			deleteOrphanObjects: false,
		});

		expect(report.removedDeletedObjects).toBe(1);
		expect(report.detectedOrphanObjects).toBe(0);
		await expect(
			stat(path.resolve(directory, deletedObject.name)),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('variant source checksum이 현재 원본과 다르면 stale variant를 Failed로 전환한다', async () => {
		const directory = path.resolve(fixtureRoot, 'image');
		await mkdir(directory, { recursive: true });
		await writeFile(path.resolve(directory, 'source.png'), 'new-source');
		await writeFile(path.resolve(directory, 'variant.webp'), 'old-variant');
		metadata.listReconciliationCandidates.mockResolvedValue([
			{
				...reconciliationAsset('source', 'Ready'),
				variants: [
					{
						variantId: 'variant-stale',
						status: 'Ready',
						sourceChecksum: 'old-source-checksum',
						object: {
							path: 'image-asset-lifecycle/image',
							name: 'variant.webp',
						},
					},
				],
			},
		]);
		metadata.listTrackedStorageKeys.mockImplementation(async (keys) => keys);

		const report = await service.reconcile({
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
		});

		expect(report.failedVariants).toBe(1);
		expect(metadata.failVariant).toHaveBeenCalledWith({
			variantId: 'variant-stale',
			reason: 'reconciliation: variant source checksum is stale',
		});
	});

	it('cursor를 다음 run에 전달해 첫 tracked batch가 뒤 orphan을 굶기지 않는다', async () => {
		const tracked = {
			path: 'image-asset-lifecycle/image',
			name: 'a-tracked.png',
			storageKey: 'image-asset-lifecycle/image/a-tracked.png',
			modifiedAt: new Date('2026-01-01T00:00:00.000Z'),
			bytes: 1,
		};
		const orphan = {
			path: 'image-asset-lifecycle/image',
			name: 'z-orphan.png',
			storageKey: 'image-asset-lifecycle/image/z-orphan.png',
			modifiedAt: new Date('2026-01-01T00:00:00.000Z'),
			bytes: 1,
		};
		jest.spyOn(filesystem, 'scanAndCleanupStagedObjects').mockResolvedValue({
			items: [],
			nextCursor: null,
		});
		const scanSpy = jest
			.spyOn(filesystem, 'scanObjects')
			.mockResolvedValueOnce({
				items: [tracked],
				nextCursor: tracked.storageKey,
			})
			.mockResolvedValueOnce({ items: [orphan], nextCursor: null });
		const deleteSpy = jest
			.spyOn(filesystem, 'deleteObjects')
			.mockResolvedValue(undefined);
		metadata.listTrackedStorageKeys.mockImplementation(async (keys) =>
			keys.filter((key) => key === tracked.storageKey),
		);

		const input = {
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
			objectScanLimit: 1,
			deleteOrphanObjects: true,
		};
		await service.reconcile(input);
		await service.reconcile(input);

		expect(scanSpy).toHaveBeenNthCalledWith(1, {
			limit: 1,
			cursor: undefined,
		});
		expect(scanSpy).toHaveBeenNthCalledWith(2, {
			limit: 1,
			cursor: tracked.storageKey,
		});
		expect(deleteSpy).toHaveBeenLastCalledWith([orphan]);
	});

	it('동시 reconciliation 중 하나만 DB lease를 얻어 filesystem을 변경한다', async () => {
		let resolveCandidates:
			((value: ImageAssetReconciliationRecord[]) => void) | undefined;
		metadata.tryAcquireReconciliationLease
			.mockResolvedValueOnce({ token: 'lease-first' })
			.mockResolvedValueOnce(null);
		metadata.listReconciliationCandidates.mockReturnValue(
			new Promise((resolve) => {
				resolveCandidates = resolve;
			}),
		);
		jest.spyOn(filesystem, 'scanAndCleanupStagedObjects').mockResolvedValue({
			items: [],
			nextCursor: null,
		});
		jest.spyOn(filesystem, 'scanObjects').mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		const first = service.reconcile({
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
		});
		await Promise.resolve();
		await Promise.resolve();
		const second = await service.reconcile({
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
		});
		resolveCandidates?.([]);
		await first;

		expect(second.leaseAcquired).toBe(false);
		expect(metadata.listReconciliationCandidates).toHaveBeenCalledTimes(1);
		expect(metadata.releaseReconciliationLease).toHaveBeenCalledTimes(1);
	});

	it('긴 run은 lease 절반 주기마다 DB lease를 갱신한다', async () => {
		jest.useFakeTimers();
		let resolveCandidates:
			((value: ImageAssetReconciliationRecord[]) => void) | undefined;
		metadata.listReconciliationCandidates.mockReturnValue(
			new Promise((resolve) => {
				resolveCandidates = resolve;
			}),
		);
		jest.spyOn(filesystem, 'scanAndCleanupStagedObjects').mockResolvedValue({
			items: [],
			nextCursor: null,
		});
		jest.spyOn(filesystem, 'scanObjects').mockResolvedValue({
			items: [],
			nextCursor: null,
		});

		const run = service.reconcile({
			updatedBefore: new Date('2026-01-01T00:05:00.000Z'),
			leaseMs: 20,
		});
		await Promise.resolve();
		jest.advanceTimersByTime(11);
		await Promise.resolve();
		await Promise.resolve();

		expect(metadata.renewReconciliationLease).toHaveBeenCalledWith({
			owner: `storage-${process.pid}`,
			token: 'lease-1',
			leaseMs: 20,
		});
		resolveCandidates?.([]);
		await run;
	});
});

const createMetadataMock = (): MetadataMock => ({
	createPendingUpload: jest.fn().mockResolvedValue(pendingAsset()),
	getAssetStatus: jest.fn().mockResolvedValue('Pending'),
	completeUpload: jest.fn().mockResolvedValue(undefined),
	repairReadyAsset: jest.fn().mockResolvedValue(undefined),
	failAsset: jest.fn().mockResolvedValue(undefined),
	beginDelete: jest.fn().mockResolvedValue(null),
	completeDelete: jest.fn().mockResolvedValue(undefined),
	recordDeleteFailure: jest.fn().mockResolvedValue(undefined),
	listReconciliationCandidates: jest.fn().mockResolvedValue([]),
	listTrackedStorageKeys: jest.fn().mockResolvedValue([]),
	listDeletedStorageKeys: jest.fn().mockResolvedValue([]),
	listRecentlyDeletedObjects: jest.fn().mockResolvedValue([]),
	failVariant: jest.fn().mockResolvedValue(undefined),
	tryAcquireReconciliationLease: jest
		.fn()
		.mockResolvedValue({ token: 'lease-1' }),
	renewReconciliationLease: jest.fn().mockResolvedValue(true),
	releaseReconciliationLease: jest.fn().mockResolvedValue(undefined),
	getReconciliationBacklogMetrics: jest.fn().mockResolvedValue({
		failedCount: 0,
		oldestPendingAt: null,
		oldestDeletingAt: null,
	}),
});

const pendingAsset = () => ({
	assetId: 'asset-1',
	clientServiceId: 'service-1',
	source: { path: 'image-asset-lifecycle/image', name: 'asset.png' },
});

const deletingAsset = (
	overrides: Partial<Omit<ImageAssetReconciliationRecord, 'status'>> = {},
): ImageAssetReconciliationRecord & {
	status: 'Deleting';
	eventId: string;
} => ({
	...pendingAsset(),
	eventId: 'delete-event-1',
	deleteEventId: 'delete-event-1',
	updatedAt: new Date('2026-01-01T00:00:00.000Z'),
	variants: [
		{
			variantId: 'variant-1',
			status: 'Ready',
			object: {
				path: 'image-asset-lifecycle/image',
				name: 'asset__w4_h4.webp',
			},
		},
	],
	...overrides,
	status: 'Deleting',
});

const reconciliationAsset = (
	name: string,
	status: 'Pending' | 'Ready',
): ImageAssetReconciliationRecord => ({
	assetId: `asset-${name}`,
	clientServiceId: 'service-1',
	status,
	updatedAt: new Date('2026-01-01T00:00:00.000Z'),
	source: {
		path: 'image-asset-lifecycle/image',
		name: `${name}.png`,
	},
	variants: [],
});

const uploadInput = () => ({
	idempotencyKey: 'upload-request-1',
	clientServiceId: 'service-1',
	logicalPath: 'image-asset-lifecycle',
	path: 'image-asset-lifecycle/image',
	name: 'asset.png',
	originalName: 'asset.png',
	contentType: 'image/png',
	inputBytes: 68,
	tempName: 'image-asset-lifecycle-source.png',
});
