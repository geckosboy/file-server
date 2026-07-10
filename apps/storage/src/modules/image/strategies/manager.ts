import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { OutputInfo, Sharp } from 'sharp';
import { mkdir, readFile, rm, stat } from 'fs/promises';
import { SharpStrategy } from './sharp';
import {
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

		/** 압축 및 저장 */
		const result = (await strategy.compressAndSave({
			from: strategy.getTempDirectory(safeTempName),
			to: strategy.getMainDirectory(`${safeSavePath}/${safeMainName}`),
		})) as Awaited<ReturnType<T['compressAndSave']>>;

		return result;
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
			width,
			height,
			format,
		});
		const sourcePath = this.pathStrategy.getMainDirectory(
			`${safePath}/${safeName}`,
		);
		const outputPath = this.pathStrategy.getMainDirectory(
			`${safePath}/${variantName}`,
		);
		const sourceStats = await stat(sourcePath);
		this.pathStrategy.assertOutputSize(sourceStats.size);
		let outputWritten = false;
		let result: OutputInfo;
		try {
			const resizedImage = this.pathStrategy.createPipeline(sourcePath).resize({
				...(width ? { width } : {}),
				...(height ? { height } : {}),
				fit: 'fill',
			});

			result = await toFormat(resizedImage, format).toFile(outputPath);
			outputWritten = true;
			this.pathStrategy.assertOutputSize(result.size);
		} catch (error) {
			if (outputWritten) {
				await rm(outputPath, { force: true });
			}
			throw this.pathStrategy.toHttpException(error);
		}

		return {
			name: variantName,
			width: width ?? undefined,
			height: height ?? undefined,
			format,
			inputBytes: sourceStats.size,
			outputBytes: result.size,
		};
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
	width,
}: {
	name: string;
	width?: number | null;
	height?: number | null;
	format: PreGeneratedImageFormat;
}) => {
	const extensionIndex = name.lastIndexOf('.');
	const baseName = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
	return `${baseName}__w${width ?? 'auto'}_h${height ?? 'auto'}.${format}`;
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
