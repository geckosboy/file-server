import {
	BadRequestException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { mkdir, readFile, rm } from 'fs/promises';
import { SharpStrategy } from './sharp';
import {
	normalizeSafeFileName,
	normalizeSafeRelativePath,
} from '../path.utils';

@Injectable()
export class ImageManager {
	private readonly pathStrategy = new SharpStrategy();

	private async createMainDirectory(path: string) {
		const result = await mkdir(path, { recursive: true });
		return result;
	}

	/** Main path의 형태는 무조건 `${path}/image`일것 */
	private normalizeMainPath(path: string) {
		const safePath = normalizeSafeRelativePath(path, 'main image path');
		if (safePath.split('/').at(-1) !== 'image') {
			throw new BadRequestException('Main image path의 형식이 잘못되었습니다.');
		}

		return safePath;
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
			const image = await readFile(
				this.pathStrategy.getMainDirectory(`${safePath}/${safeName}`),
			);

			return { image, name: safeName };
		} catch {
			throw new NotFoundException(
				'파일이 존재하지 않거나 불러올 수 없는 상태입니다.',
			);
		}
	}
}
