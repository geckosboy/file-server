import {
	BadRequestException,
	Inject,
	Injectable,
	Logger,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { extension } from 'mime-types';
import { performance } from 'perf_hooks';
import { lastValueFrom } from 'rxjs';

import { GetImageDto, UploadImageDto } from '@file/image-contracts';
import { PngStrategy } from './strategies/sharp/png.strategy';
import { JpegStrategy } from './strategies/sharp/jpeg.strategy';
import { ImageManager } from './strategies/manager';
import { SharpStrategy } from './strategies/sharp';
import { normalizeSafeFileName } from './path.utils';

@Injectable()
export class ImageService {
	private readonly logger = new Logger(ImageService.name);

	constructor(
		private readonly pngStrategy: PngStrategy,
		private readonly jpegStrategy: JpegStrategy,
		private readonly imageManager: ImageManager,
		@Inject('IMAGE_MICROSERVICE') private readonly imageClient: ClientKafka,
	) {}

	/** MimeType으로 확장자 가져오기 */
	private getExt(mimeType: string) {
		const ext = extension(mimeType);
		if (!this.isExtValid(ext)) {
			throw new BadRequestException('알 수 없는 MIME type 입니다.');
		}

		return ext;
	}

	/** 확장자에 따라 맞는 Strategy 가져오기 */
	private getStrategy(ext: string): SharpStrategy {
		switch (ext) {
			case 'png':
				return this.pngStrategy;
			case 'jpeg':
			case 'jpg':
				return this.jpegStrategy;
			default:
				throw new BadRequestException('알 수 없는 MIME type 입니다.');
		}
	}

	/** MimeType을 기준으로 요청 로컬 Strategy를 선택 */
	private getStrategyFromMimeType(mimetype: string) {
		const ext = this.getExt(mimetype);
		return this.getStrategy(ext);
	}

	/** 확장자가 정상적인지 */
	private isExtValid(ext: string | boolean): ext is string {
		return typeof ext === 'string';
	}

	/** 이미지 압축 후 저장 */
	async compressAndSaveImage(imageInfo: {
		file: Express.Multer.File;
		apiInfo: Pick<UploadImageDto, 'id' | 'path'>;
	}) {
		const { apiInfo, file } = imageInfo;
		const strategy = this.getStrategyFromMimeType(file.mimetype);
		const mainName = normalizeSafeFileName(file.originalname, 'original name');

		try {
			const startTime = performance.now();
			const { format, size } = await this.imageManager.saveImageFromTemp(
				strategy,
				{
					savePath: apiInfo.path,
					mainName,
					tempName: file.filename,
				},
			);
			const exeTime = performance.now() - startTime;

			this.logger.log(
				`[${apiInfo.id}]${apiInfo.path}/${mainName} - ${format} ${file.size}>>${size}byte +${Math.round(exeTime)}ms `,
			);

			return { format, size, exeTime };
		} catch (error) {
			this.logger.error(error);
			throw error;
		}
	}

	/** Path, Name 기준으로 이미지 삭제. 만약 Path가 없고 isTemp가 true라면 temp폴더에서 이름에 해당하는 파일 삭제 */
	async deleteImage(imageInfo: { path?: string; name: string; isTemp?: true }) {
		const { name, path, isTemp } = imageInfo;
		if (!isTemp && path) {
			await this.imageManager.deleteMainImage({ path, name });
			return;
		}

		await this.imageManager.deleteTempImage(name);
	}

	/** Buffer형식의 이미지 데이터 가져오기 */
	async getImage(imageInfo: GetImageDto) {
		const { path, name } = imageInfo;
		const result = await this.imageManager.getBufferImage({
			path: `${path}/image`,
			name,
		});

		return result;
	}

	/** 로컬에 이미지 업로드 */
	async uploadFile(imageInfo: {
		file: Express.Multer.File;
		apiInfo: UploadImageDto;
	}) {
		const {
			apiInfo: { id, path, beforeName },
			file,
		} = imageInfo;

		try {
			const { exeTime, format, size } = await this.compressAndSaveImage({
				file,
				apiInfo: { id, path },
			});
			/** 이미지 업로드 결과를 Message Queue에 전달 */
			await lastValueFrom(
				this.imageClient.emit('image-topic', {
					key: 'uploadResult-json',
					value: JSON.stringify({
						id,
						format,
						size,
						exeTime,
					}),
				}),
			);

			/** 전에 사용하던 파일이 있는 경우 삭제 */
			if (beforeName) {
				await this.deleteImage({ path, name: beforeName });
			}
		} finally {
			/** 처리완료 또는 실패한 임시 파일은 항상 삭제 */
			await this.deleteImage({ isTemp: true, name: file.filename });
		}
	}
}
