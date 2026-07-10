import { ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { copyFile, mkdir, rm, stat, utimes, writeFile } from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import { Root } from 'src/enum';
import {
	ImageFilesystemStore,
	StagedImageObject,
} from '.././image-filesystem.store';
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
			width: 1,
			height: 1,
			channels: 4 as const,
			premultiplied: false,
		};
	}
}

class PartialFailureStrategy extends CopyStrategy {
	override async compressAndSave(info: {
		from: string;
		to: string;
	}): Promise<sharp.OutputInfo> {
		await writeFile(info.to, 'partial-output');
		throw new Error('injected disk write failure');
	}
}

class WrongMetadataStrategy extends CopyStrategy {
	override async compressAndSave(info: {
		from: string;
		to: string;
	}): Promise<sharp.OutputInfo> {
		const output = await super.compressAndSave(info);
		return { ...output, size: output.size + 1 };
	}
}

describe('파일시스템 이미지 저장소', () => {
	const assetsRoot = path.resolve(Root, 'assets');
	const tempRoot = path.resolve(Root, 'temp');
	const fixtureRoot = path.resolve(assetsRoot, 'image-lifecycle-filesystem');
	const sourcePath = path.resolve(tempRoot, 'image-lifecycle-source.png');
	let store: ImageFilesystemStore;
	let strategy: CopyStrategy;

	beforeEach(async () => {
		store = new ImageFilesystemStore();
		strategy = new CopyStrategy();
		await rm(fixtureRoot, { recursive: true, force: true });
		await mkdir(tempRoot, { recursive: true });
		await writeFile(sourcePath, 'image-lifecycle-source');
	});

	afterEach(async () => {
		await rm(fixtureRoot, { recursive: true, force: true });
		await rm(sourcePath, { force: true });
	});

	it('canonical 경로를 노출하기 전에 같은 디렉터리의 staging 영역에 기록한다', async () => {
		const staged = await store.stageImage(strategy, {
			path: 'image-lifecycle-filesystem/image',
			name: 'asset.png',
			tempName: 'image-lifecycle-source.png',
		});

		expect(staged).toEqual(
			expect.objectContaining({
				path: 'image-lifecycle-filesystem/image',
				name: 'asset.png',
				storageKey: 'image-lifecycle-filesystem/image/asset.png',
				checksum: createHash('sha256')
					.update('image-lifecycle-source')
					.digest('hex'),
				size: Buffer.byteLength('image-lifecycle-source'),
				format: 'png',
				width: 1,
				height: 1,
			}),
		);
		await expect(
			stat(path.resolve(fixtureRoot, 'image', 'asset.png')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(
			stat(path.resolve(fixtureRoot, 'image', '.staging', staged.stagingName)),
		).resolves.toBeDefined();
	});

	it('stage를 canonical 경로로 승격하고 같은 요청을 멱등 처리한다', async () => {
		const staged = await stageDefault(store, strategy);

		await store.promoteImage(staged);
		await expect(store.hasObject(staged)).resolves.toBe(true);
		await expect(store.promoteImage(staged)).resolves.toBeUndefined();
	});

	it('부분 파일을 남긴 쓰기 실패도 staging 영역에서 정리한다', async () => {
		await expect(
			store.stageImage(new PartialFailureStrategy(), {
				path: 'image-lifecycle-filesystem/image',
				name: 'asset.png',
				tempName: 'image-lifecycle-source.png',
			}),
		).rejects.toThrow('injected disk write failure');

		const stagingDirectory = path.resolve(fixtureRoot, 'image', '.staging');
		await expect(readDirectoryOrEmpty(stagingDirectory)).resolves.toEqual([]);
	});

	it('strategy metadata와 durable stage 크기가 다르면 승격하지 않는다', async () => {
		await expect(
			store.stageImage(new WrongMetadataStrategy(), {
				path: 'image-lifecycle-filesystem/image',
				name: 'asset.png',
				tempName: 'image-lifecycle-source.png',
			}),
		).rejects.toThrow('staged image metadata does not match');
		await expect(
			readDirectoryOrEmpty(path.resolve(fixtureRoot, 'image', '.staging')),
		).resolves.toEqual([]);
	});

	it('checksum 계산 실패를 주입하면 canonical 파일과 stage를 모두 남기지 않는다', async () => {
		const failpoints = {
			trigger: jest.fn((failpoint: ImageLifecycleFailpoint) => {
				if (failpoint === ImageLifecycleFailpoint.BeforeStageChecksum) {
					throw new Error('injected checksum failure');
				}
			}),
		};
		const failingStore = new ImageFilesystemStore(
			failpoints as unknown as ImageLifecycleFailpointService,
		);

		await expect(
			failingStore.stageImage(strategy, {
				path: 'image-lifecycle-filesystem/image',
				name: 'asset.png',
				tempName: 'image-lifecycle-source.png',
			}),
		).rejects.toThrow('injected checksum failure');
		await expect(
			readDirectoryOrEmpty(path.resolve(fixtureRoot, 'image', '.staging')),
		).resolves.toEqual([]);
		await expect(
			stat(path.resolve(fixtureRoot, 'image', 'asset.png')),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('다른 내용의 canonical 객체를 덮어쓰지 않고 reconciliation용 stage를 유지한다', async () => {
		const staged = await stageDefault(store, strategy);
		const finalPath = path.resolve(fixtureRoot, 'image', 'asset.png');
		await writeFile(finalPath, 'conflicting-object');

		await expect(store.promoteImage(staged)).rejects.toBeInstanceOf(
			ConflictException,
		);
		await expect(
			stat(path.resolve(fixtureRoot, 'image', '.staging', staged.stagingName)),
		).resolves.toBeDefined();
	});

	it('stale stage만 정리하고 아직 처리 중인 stage는 보존한다', async () => {
		const stale = await stageDefault(store, strategy);
		const fresh = await store.stageImage(strategy, {
			path: 'image-lifecycle-filesystem/image',
			name: 'fresh.png',
			tempName: 'image-lifecycle-source.png',
		});
		const stalePath = path.resolve(
			fixtureRoot,
			'image',
			'.staging',
			stale.stagingName,
		);
		const staleTime = new Date('2026-01-01T00:00:00.000Z');
		await utimes(stalePath, staleTime, staleTime);

		const removed = await store.cleanupStagedObjects(
			new Date('2026-01-01T00:01:00.000Z'),
		);

		expect(removed).toEqual([
			`image-lifecycle-filesystem/image/.staging/${stale.stagingName}`,
		]);
		await expect(
			stat(path.resolve(fixtureRoot, 'image', '.staging', fresh.stagingName)),
		).resolves.toBeDefined();
	});

	it('프로세스 중단으로 남은 inbound temp 파일만 bounded cleanup한다', async () => {
		const stalePath = path.resolve(
			tempRoot,
			'000-image-lifecycle-stale-upload.tmp',
		);
		const freshPath = path.resolve(
			tempRoot,
			'zzz-image-lifecycle-fresh-upload.tmp',
		);
		await Promise.all([
			writeFile(stalePath, 'stale'),
			writeFile(freshPath, 'fresh'),
		]);
		const staleTime = new Date('2026-01-01T00:00:00.000Z');
		await utimes(stalePath, staleTime, staleTime);

		const result = await store.scanAndCleanupInboundTempFiles({
			olderThan: new Date('2026-01-01T00:01:00.000Z'),
			limit: 1,
		});

		expect(result.items).toEqual(['000-image-lifecycle-stale-upload.tmp']);
		await expect(stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(stat(freshPath)).resolves.toBeDefined();
		await rm(freshPath, { force: true });
	});

	it('원본과 variant 삭제를 중복 요청해도 모두 사라진 상태를 유지한다', async () => {
		const directory = path.resolve(fixtureRoot, 'image');
		await mkdir(directory, { recursive: true });
		await writeFile(path.resolve(directory, 'asset.png'), 'source');
		await writeFile(
			path.resolve(directory, 'asset__w400_h400.webp'),
			'variant',
		);
		const objects = [
			{ path: 'image-lifecycle-filesystem/image', name: 'asset.png' },
			{
				path: 'image-lifecycle-filesystem/image',
				name: 'asset__w400_h400.webp',
			},
		];

		await store.deleteObjects(objects);
		await expect(store.deleteObjects(objects)).resolves.toBeUndefined();
		await expect(store.hasObject(objects[0])).resolves.toBe(false);
		await expect(store.hasObject(objects[1])).resolves.toBe(false);
	});

	it('reconciliation 목록에서는 staging 파일을 제외한다', async () => {
		const staged = await stageDefault(store, strategy);
		await store.promoteImage(staged);
		await store.stageImage(strategy, {
			path: 'image-lifecycle-filesystem/image',
			name: 'pending.png',
			tempName: 'image-lifecycle-source.png',
		});

		const objects = await store.listObjects();

		expect(objects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					storageKey: 'image-lifecycle-filesystem/image/asset.png',
					bytes: Buffer.byteLength('image-lifecycle-source'),
				}),
			]),
		);
		expect(
			objects.some((object) => object.storageKey.includes('/.staging/')),
		).toBe(false);
	});

	it('object/stage cursor가 bounded batch 다음 항목으로 공정하게 진행한다', async () => {
		const directory = path.resolve(fixtureRoot, 'image');
		await mkdir(path.resolve(directory, '.staging'), { recursive: true });
		await writeFile(path.resolve(directory, 'a.png'), 'a');
		await writeFile(path.resolve(directory, 'b.png'), 'b');
		await writeFile(path.resolve(directory, '.staging', 'a.stage'), 'a-stage');
		await writeFile(path.resolve(directory, '.staging', 'b.stage'), 'b-stage');

		const firstObjects = await store.scanObjects({ limit: 1 });
		const secondObjects = await store.scanObjects({
			limit: 1,
			cursor: firstObjects.nextCursor ?? undefined,
		});
		expect(firstObjects.items.map((item) => item.name)).toEqual(['a.png']);
		expect(secondObjects.items.map((item) => item.name)).toEqual(['b.png']);

		const firstStages = await store.scanAndCleanupStagedObjects({
			olderThan: new Date(Date.now() + 1_000),
			limit: 1,
		});
		const secondStages = await store.scanAndCleanupStagedObjects({
			olderThan: new Date(Date.now() + 1_000),
			limit: 1,
			cursor: firstStages.nextCursor ?? undefined,
		});
		expect(firstStages.items).toEqual([
			'image-lifecycle-filesystem/image/.staging/a.stage',
		]);
		expect(secondStages.items).toEqual([
			'image-lifecycle-filesystem/image/.staging/b.stage',
		]);
	});
});

const stageDefault = (
	store: ImageFilesystemStore,
	strategy: CopyStrategy,
): Promise<StagedImageObject> =>
	store.stageImage(strategy, {
		path: 'image-lifecycle-filesystem/image',
		name: 'asset.png',
		tempName: 'image-lifecycle-source.png',
	});

const readDirectoryOrEmpty = async (directory: string) => {
	try {
		return await import('fs/promises').then(({ readdir }) =>
			readdir(directory),
		);
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			(error as NodeJS.ErrnoException).code === 'ENOENT'
		) {
			return [];
		}
		throw error;
	}
};
