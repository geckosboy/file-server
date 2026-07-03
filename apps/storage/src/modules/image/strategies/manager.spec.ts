import { BadRequestException, NotFoundException } from '@nestjs/common';
import { copyFile, mkdir, rm, stat, writeFile } from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { Root } from 'src/enum';
import { SharpStrategy } from './sharp';
import { createPreGeneratedVariantName, ImageManager } from './manager';

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

describe('스토리지 이미지 매니저', () => {
	const tempRoot = path.resolve(Root, 'temp');
	const assetRoot = path.resolve(Root, 'assets', 'unit-manager');
	let manager: ImageManager;
	let strategy: CopyStrategy;

	beforeEach(async () => {
		manager = new ImageManager();
		strategy = new CopyStrategy();
		await rm(assetRoot, { recursive: true, force: true });
		await mkdir(tempRoot, { recursive: true });
	});

	afterEach(async () => {
		await rm(assetRoot, { recursive: true, force: true });
		await rm(path.resolve(tempRoot, 'source.png'), { force: true });
	});

	it('임시 이미지를 요청한 메인 이미지 디렉터리에 저장한다', async () => {
		const tempImage = Buffer.from('stored-image');
		await writeFile(path.resolve(tempRoot, 'source.png'), tempImage);

		const result = await manager.saveImageFromTemp(strategy, {
			tempName: 'source.png',
			mainName: 'main.png',
			savePath: 'unit-manager/image',
		});
		const stored = await manager.getBufferImage({
			path: 'unit-manager/image',
			name: 'main.png',
		});

		expect(result.size).toBe(tempImage.byteLength);
		expect(stored.name).toBe('main.png');
		expect(stored.image.equals(tempImage)).toBe(true);
	});

	it('요청한 메인 이미지 디렉터리에서 이미지를 삭제한다', async () => {
		await mkdir(path.resolve(assetRoot, 'image'), { recursive: true });
		await writeFile(
			path.resolve(assetRoot, 'image', 'delete.png'),
			'delete-me',
		);

		await manager.deleteMainImage({
			path: 'unit-manager/image',
			name: 'delete.png',
		});

		await expect(
			manager.getBufferImage({
				path: 'unit-manager/image',
				name: 'delete.png',
			}),
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('저장된 원본에서 사전 생성 리사이징 파일을 만든다', async () => {
		const source = await sharp({
			create: {
				width: 12,
				height: 8,
				channels: 3,
				background: '#123456',
			},
		})
			.png()
			.toBuffer();
		await mkdir(path.resolve(assetRoot, 'image'), { recursive: true });
		await writeFile(path.resolve(assetRoot, 'image', 'main.png'), source);

		const result = await manager.createPreGeneratedVariant({
			path: 'unit-manager/image',
			name: 'main.png',
			width: 4,
			height: 4,
			format: 'webp',
		});
		const variant = await manager.getBufferImage({
			path: 'unit-manager/image',
			name: 'main__w4_h4.webp',
		});
		const metadata = await sharp(variant.image).metadata();

		expect(result).toEqual(
			expect.objectContaining({
				name: 'main__w4_h4.webp',
				width: 4,
				height: 4,
				format: 'webp',
				inputBytes: source.byteLength,
				outputBytes: expect.any(Number),
			}),
		);
		expect(metadata.format).toBe('webp');
		expect(metadata.width).toBe(4);
		expect(metadata.height).toBe(4);
	});

	it('사전 생성 파일명을 원본 이름과 사이즈 기준으로 만든다', () => {
		expect(
			createPreGeneratedVariantName({
				name: 'hero.banner.png',
				width: 320,
				format: 'jpeg',
			}),
		).toBe('hero.banner__w320_hauto.jpeg');
	});

	it('이미지로 끝나지 않는 메인 경로를 거부한다', async () => {
		await expect(
			manager.getBufferImage({ path: 'unit-manager', name: 'main.png' }),
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
