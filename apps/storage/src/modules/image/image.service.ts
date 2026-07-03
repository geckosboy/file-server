import {
	BadRequestException,
	Inject,
	Injectable,
	Logger,
	Optional,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
	ClientServiceAuthContext,
	createClientServiceForwardHeaders,
	createClientServiceTelemetryFields,
} from '@file/database';
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
import {
	createImageLifecycleEvent,
	ImageLifecycleEvent,
	ImageLifecycleEventType,
	ImageLifecycleStatus,
} from './image.lifecycle';
import { ImageLifecycleOutboxService } from './image-lifecycle-outbox.service';
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
		private readonly lifecycleOutbox: ImageLifecycleOutboxService,
		@Optional() private readonly appConfig?: AppConfig,
	) {}

	private async publishTelemetryEvent(event: ImageTelemetryEvent) {
		await publishImageTelemetryEvent({
			client: this.imageClient,
			event,
			logger: this.logger,
		});
	}

	private async publishLifecycleEvent(event: ImageLifecycleEvent) {
		await this.lifecycleOutbox.enqueueAndPublish(event);
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
		clientServiceContext,
		name,
		path,
	}: {
		path: string;
		name: string;
		clientServiceContext?: ClientServiceAuthContext;
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

		const headers = createClientServiceForwardHeaders(clientServiceContext);
		if (Object.keys(headers).length === 0) {
			this.logger.warn(
				'클라이언트 서비스 인증 컨텍스트가 없어 캐시 무효화를 건너뜁니다.',
			);
			return;
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
	async deleteImage(imageInfo: {
		path?: string;
		name: string;
		isTemp?: true;
		clientServiceContext?: ClientServiceAuthContext;
	}) {
		const { clientServiceContext, name, path, isTemp } = imageInfo;
		if (!isTemp && path) {
			await this.imageManager.deleteMainImage({ path, name });
			await this.invalidateCachedImage({
				path,
				name,
				clientServiceContext,
			});
			return;
		}

		await this.imageManager.deleteTempImage(name);
	}

	/** Buffer형식의 이미지 데이터 가져오기 */
	async getImage(
		imageInfo: GetImageDto,
		clientServiceContext?: ClientServiceAuthContext,
	) {
		const { path, name } = imageInfo;
		const telemetryContext =
			createClientServiceTelemetryFields(clientServiceContext);

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
					...telemetryContext,
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
					...telemetryContext,
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
		clientServiceContext?: ClientServiceAuthContext;
	}) {
		const {
			apiInfo: { id, path, beforeName },
			clientServiceContext,
			file,
		} = imageInfo;
		const telemetryContext =
			createClientServiceTelemetryFields(clientServiceContext);

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

			await this.publishLifecycleEvent(
				createImageLifecycleEvent({
					eventType: ImageLifecycleEventType.UploadCompleted,
					imageId: id,
					path,
					name,
					format: normalizeImageFormat(format),
					inputBytes: file.size,
					outputBytes: size,
					durationMs: exeTime,
					status: ImageLifecycleStatus.Success,
					...telemetryContext,
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
					...telemetryContext,
				}),
			);

			await this.invalidateCachedImage({
				path,
				name,
				clientServiceContext,
			});

			/** 전에 사용하던 파일이 있는 경우 삭제 */
			if (beforeName && beforeName !== name) {
				await this.deleteImage({
					path,
					name: beforeName,
					clientServiceContext,
				});
			}
		} catch (error) {
			const failedFields = createFailedTelemetryFields(error);
			await this.publishLifecycleEvent(
				createImageLifecycleEvent({
					eventType: ImageLifecycleEventType.UploadFailed,
					imageId: id,
					path,
					name: this.getTelemetryFileName(file),
					format: normalizeImageFormat(file.originalname),
					inputBytes: file.size,
					status: ImageLifecycleStatus.Failed,
					...telemetryContext,
					...failedFields,
				}),
			);

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
					...telemetryContext,
					...failedFields,
				}),
			);
			throw error;
		} finally {
			/** 처리완료 또는 실패한 임시 파일은 항상 삭제 */
			await this.deleteImage({ isTemp: true, name: file.filename });
		}
	}
}
