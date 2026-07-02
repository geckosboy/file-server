import {
	BadRequestException,
	Inject,
	Injectable,
	Logger,
	Optional,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { extension } from 'mime-types';
import { performance } from 'perf_hooks';
import { lastValueFrom } from 'rxjs';

import { GetImageDto, UploadImageDto } from '@file/image-contracts';
import {
	createFailedTelemetryFields,
	createImageTelemetryEvent,
	ImageTelemetryEvent,
	ImageTelemetryEventType,
	normalizeImageFormat,
	publishImageTelemetryEvent,
} from './image.telemetry';
import { PngStrategy } from './strategies/sharp/png.strategy';
import { JpegStrategy } from './strategies/sharp/jpeg.strategy';
import { ImageManager } from './strategies/manager';
import { SharpStrategy } from './strategies/sharp';
import { normalizeSafeFileName } from './path.utils';
import { AppConfig } from 'src/config/env.schema';

@Injectable()
export class ImageService {
	private readonly logger = new Logger(ImageService.name);

	constructor(
		private readonly pngStrategy: PngStrategy,
		private readonly jpegStrategy: JpegStrategy,
		private readonly imageManager: ImageManager,
		@Inject('IMAGE_MICROSERVICE') private readonly imageClient: ClientKafka,
		@Optional() private readonly appConfig?: AppConfig,
	) {}

	private async publishTelemetryEvent(event: ImageTelemetryEvent) {
		await publishImageTelemetryEvent({
			client: this.imageClient,
			event,
			logger: this.logger,
		});
	}

	private getTelemetryFileName(file: Express.Multer.File) {
		try {
			return normalizeSafeFileName(file.originalname, 'original name');
		} catch {
			return file.originalname;
		}
	}

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

	private getPublicCachePath(storagePath: string) {
		const imagePathSuffix = '/image';
		if (storagePath.endsWith(imagePathSuffix)) {
			return storagePath.slice(0, -imagePathSuffix.length);
		}

		return storagePath;
	}

	private async invalidateCachedImage({
		name,
		path,
	}: {
		path: string;
		name: string;
	}) {
		const cacheServer = this.appConfig?.CACHE_SERVER;
		if (!cacheServer) {
			return;
		}

		const cachePath = this.getPublicCachePath(path);
		if (!cachePath) {
			this.logger.warn('캐시 무효화 경로가 비어 있어 요청을 건너뜁니다.');
			return;
		}

		const headers: Record<string, string> = {};
		if (this.appConfig?.INTERNAL_API_KEY) {
			headers['x-internal-api-key'] = this.appConfig.INTERNAL_API_KEY;
		}

		const url = `${cacheServer}/image/${encodeURIComponent(
			cachePath,
		)}/${encodeURIComponent(name)}/cache`;

		try {
			const response = await fetch(url, { method: 'DELETE', headers });
			if (!response.ok) {
				this.logger.warn(
					`캐시 무효화 요청 실패: ${response.status} ${response.statusText}`,
				);
			}
		} catch (error) {
			const { errorMessage } = createFailedTelemetryFields(error);
			this.logger.warn(`캐시 무효화 요청 실패: ${errorMessage}`);
		}
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

			return { format, size, exeTime, name: mainName };
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
			await this.invalidateCachedImage({ path, name });
			return;
		}

		await this.imageManager.deleteTempImage(name);
	}

	/** Buffer형식의 이미지 데이터 가져오기 */
	async getImage(imageInfo: GetImageDto) {
		const { path, name } = imageInfo;

		try {
			const result = await this.imageManager.getBufferImage({
				path: `${path}/image`,
				name,
			});

			await this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventType: ImageTelemetryEventType.ReadCompleted,
					sourceApp: 'storage',
					path,
					name: result.name,
					format: normalizeImageFormat(result.name),
					outputBytes: result.image.byteLength,
					status: 'success',
				}),
			);

			return result;
		} catch (error) {
			await this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventType: ImageTelemetryEventType.ReadFailed,
					sourceApp: 'storage',
					path,
					name,
					format: normalizeImageFormat(name),
					status: 'failed',
					...createFailedTelemetryFields(error),
				}),
			);
			throw error;
		}
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
			const { exeTime, format, name, size } = await this.compressAndSaveImage({
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

			await this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventType: ImageTelemetryEventType.UploadCompleted,
					sourceApp: 'storage',
					imageId: id,
					path,
					name,
					format: normalizeImageFormat(format),
					inputBytes: file.size,
					outputBytes: size,
					durationMs: exeTime,
					status: 'success',
				}),
			);

			await this.invalidateCachedImage({ path, name });

			/** 전에 사용하던 파일이 있는 경우 삭제 */
			if (beforeName && beforeName !== name) {
				await this.deleteImage({ path, name: beforeName });
			}
		} catch (error) {
			await this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventType: ImageTelemetryEventType.UploadFailed,
					sourceApp: 'storage',
					imageId: id,
					path,
					name: this.getTelemetryFileName(file),
					format: normalizeImageFormat(file.originalname),
					inputBytes: file.size,
					status: 'failed',
					...createFailedTelemetryFields(error),
				}),
			);
			throw error;
		} finally {
			/** 처리완료 또는 실패한 임시 파일은 항상 삭제 */
			await this.deleteImage({ isTemp: true, name: file.filename });
		}
	}
}
