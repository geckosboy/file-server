import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { OutputInfo, Sharp } from 'sharp';
import { mkdir, readFile, readdir, rename, rm, stat } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { relative, sep } from 'path';
import { SharpStrategy } from './sharp';
import {
	createBoundedImageVariantName,
	normalizeImageStoragePath,
	normalizeSafeFileName,
} from '@file/image-contracts';

@Injectable()
export class ImageManager {
	private readonly pathStrategy = new SharpStrategy();

	private async createMainDirectory(path: string) {
		const result = await mkdir(path, { recursive: true });
		return result;
	}

	/** Main path의 형태는 무조건 `${path}/image`일것 */
	private normalizeMainPath(path: string) {
		return normalizeImageStoragePath(path);
	}

	/** Temp 폴더에 있는 이미지를 압축하고 Main폴더에 저장 */
	async saveImageFromTemp<T extends SharpStrategy>(
		strategy: T,
		info: {
			mainName: string;
			tempName: string;
			savePath: string;
		},
	): Promise<Awaited<ReturnType<T['compressAndSave']>>> {
		const { mainName, savePath, tempName } = info;
		const safeSavePath = this.normalizeMainPath(savePath);
		const safeMainName = normalizeSafeFileName(mainName, 'main name');
		const safeTempName = normalizeSafeFileName(tempName, 'temp name');

		/** Save하기 전에 미리 Directory 생성 */
		const path = strategy.getMainDirectory(safeSavePath);
		await this.createMainDirectory(path);

		/**
		 * Final 이름에 직접 쓰지 않는다. 같은 directory의 staging 파일에
		 * 압축/검증한 뒤 rename하여 filesystem 관점의 publish를 원자화한다.
		 */
		const stagingName = `${safeMainName}.stage-${randomUUID()}`;
		const stagingPath = strategy.getMainDirectory(
			`${safeSavePath}/${stagingName}`,
		);
		const finalPath = strategy.getMainDirectory(
			`${safeSavePath}/${safeMainName}`,
		);
		try {
			const result = (await strategy.compressAndSave({
				from: strategy.getTempDirectory(safeTempName),
				to: stagingPath,
			})) as Awaited<ReturnType<T['compressAndSave']>>;
			const checksum = createHash('sha256')
				.update(await readFile(stagingPath))
				.digest('hex');
			await rename(stagingPath, finalPath);

			return Object.assign(result as object, { checksum }) as Awaited<
				ReturnType<T['compressAndSave']>
			> & { checksum: string };
		} catch (error) {
			await rm(stagingPath, { force: true });
			throw error;
		}
	}

	/** Main 폴더에 저장된 원본을 지정된 사전 생성 사이즈 파일로 리사이징한다. */
	async createPreGeneratedVariant(info: {
		path: string;
		name: string;
		width?: number | null;
		height?: number | null;
		format: PreGeneratedImageFormat;
	}) {
		const { format, height, name, path, width } = info;
		const safePath = this.normalizeMainPath(path);
		const safeName = normalizeSafeFileName(name, 'main name');
		const variantName = createPreGeneratedVariantName({
			name: safeName,
			path: safePath,
			width,
			height,
			format,
		});
		const sourcePath = this.pathStrategy.getMainDirectory(
			`${safePath}/${safeName}`,
		);
		const stagingDirectory = this.pathStrategy.getMainDirectory(
			`${safePath}/.staging`,
		);
		const stagingPath = this.pathStrategy.getMainDirectory(
			`${safePath}/.staging/${randomUUID()}.variant-stage`,
		);
		const outputPath = this.pathStrategy.getMainDirectory(
			`${safePath}/${variantName}`,
		);
		const sourceStats = await stat(sourcePath);
		this.pathStrategy.assertOutputSize(sourceStats.size);
		let result: OutputInfo;
		try {
			await mkdir(stagingDirectory, { recursive: true });
			const resizedImage = this.pathStrategy.createPipeline(sourcePath).resize({
				...(width ? { width } : {}),
				...(height ? { height } : {}),
				fit: 'fill',
			});

			result = await toFormat(resizedImage, format).toFile(stagingPath);
			this.pathStrategy.assertOutputSize(result.size);
			const checksum = createHash('sha256')
				.update(await readFile(stagingPath))
				.digest('hex');
			await rename(stagingPath, outputPath);

			return {
				name: variantName,
				width: width ?? undefined,
				height: height ?? undefined,
				format,
				inputBytes: sourceStats.size,
				outputBytes: result.size,
				checksum,
			};
		} catch (error) {
			await rm(stagingPath, { force: true });
			throw this.pathStrategy.toHttpException(error);
		}
	}

	/** Main 폴더에 있는 이미지 제거 */
	async deleteMainImage({ path, name }: { path: string; name: string }) {
		const safePath = this.normalizeMainPath(path);
		const safeName = normalizeSafeFileName(name);

		await rm(this.pathStrategy.getMainDirectory(`${safePath}/${safeName}`), {
			force: true,
		});
	}

	/** Temp 폴더에 있는 이미지 제거 */
	async deleteTempImage(name: string) {
		const safeName = normalizeSafeFileName(name);

		await rm(this.pathStrategy.getTempDirectory(safeName), {
			force: true,
		});
	}

	async mainImageExists({ path, name }: { path: string; name: string }) {
		const safePath = this.normalizeMainPath(path);
		const safeName = normalizeSafeFileName(name);
		try {
			await stat(this.pathStrategy.getMainDirectory(`${safePath}/${safeName}`));
			return true;
		} catch {
			return false;
		}
	}

	async listStoredImageKeys(): Promise<string[]> {
		const root = this.pathStrategy.getMainDirectory();
		try {
			const files = await walkFiles(root);
			return files
				.map((file) => relative(root, file).split(sep).join('/'))
				.filter((key) => !key.includes('.stage-'));
		} catch {
			return [];
		}
	}

	/** Buffer 형태의 이미지 데이터 가져오기 */
	async getBufferImage({ path, name }: { path: string; name: string }) {
		const safePath = this.normalizeMainPath(path);
		const safeName = normalizeSafeFileName(name);

		try {
			const imagePath = this.pathStrategy.getMainDirectory(
				`${safePath}/${safeName}`,
			);
			const imageStats = await stat(imagePath);
			this.pathStrategy.assertOutputSize(imageStats.size);
			const image = await readFile(imagePath);

			return { image, name: safeName };
		} catch (error) {
			if (error instanceof HttpException) {
				throw error;
			}
			throw new NotFoundException(
				'파일이 존재하지 않거나 불러올 수 없는 상태입니다.',
			);
		}
	}
}

export type PreGeneratedImageFormat = 'png' | 'jpeg' | 'webp';

export const createPreGeneratedVariantName = ({
	format,
	height,
	name,
	path,
	width,
}: {
	name: string;
	path?: string;
	width?: number | null;
	height?: number | null;
	format: PreGeneratedImageFormat;
}) => {
	return createBoundedImageVariantName({
		name,
		path: path ?? 'image',
		width,
		height,
		format,
	});
};

function toFormat(image: Sharp, format: PreGeneratedImageFormat) {
	switch (format) {
		case 'png':
			return image.png({ compressionLevel: 5 });
		case 'jpeg':
			return image.jpeg({ quality: 60 });
		case 'webp':
			return image.webp({ quality: 75 });
	}
}

async function walkFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = `${directory}/${entry.name}`;
			return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
		}),
	);
	return nested.flat();
}
