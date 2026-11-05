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
	createInternalServiceForwardHeaders,
	createClientServiceTelemetryFields,
} from '@file/database';
import { createHash, randomUUID } from 'crypto';
import { extension } from 'mime-types';
import { performance } from 'perf_hooks';

import {
	getMaxImageFileNameLengthForPath,
	GetImageDto,
	ImageEntity,
	MAX_SAFE_FILE_NAME_LENGTH,
	UploadImageDto,
	normalizeImageStoragePath,
	normalizeSafeFileName,
} from '@file/image-contracts';
import {
	createFailedTelemetryFields,
	createImageTelemetryEvent,
	ImageTelemetryEvent,
	ImageTelemetryEventType,
	ImageTelemetryStage,
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
import {
	ImagePregenerationResult,
	ImagePregenerationService,
} from './image-pregeneration.service';
import { PngStrategy } from './strategies/sharp/png.strategy';
import { JpegStrategy } from './strategies/sharp/jpeg.strategy';
import { ImageManager } from './strategies/manager';
import { SharpStrategy } from './strategies/sharp';
import { AppConfig } from 'src/config/env.schema';
import {
	ImageAssetDeleteFailure,
	ImageAssetLifecycleService,
} from './image-asset-lifecycle.service';
import { ImageCacheInvalidationPublisher } from './image-cache-invalidation.publisher';
import { ImageLifecycleMetricsService } from './image-lifecycle-metrics.service';

@Injectable()
export class ImageService {
	private readonly logger = new Logger(ImageService.name);

	constructor(
		private readonly pngStrategy: PngStrategy,
		private readonly jpegStrategy: JpegStrategy,
		private readonly imageManager: ImageManager,
		@Inject('IMAGE_MICROSERVICE') private readonly imageClient: ClientKafka,
		private readonly lifecycleOutbox: ImageLifecycleOutboxService,
		private readonly imagePregenerationService: ImagePregenerationService,
		@Optional() private readonly appConfig?: AppConfig,
		@Optional()
		private readonly assetLifecycle?: ImageAssetLifecycleService,
		@Optional()
		private readonly cacheInvalidationPublisher?: ImageCacheInvalidationPublisher,
		@Optional()
		private readonly imageLifecycleMetrics?: ImageLifecycleMetricsService,
	) {}

	private publishTelemetryEvent(event: ImageTelemetryEvent): void {
		void publishImageTelemetryEvent({
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

	private createPreGeneratedVariantKey(
		imageKey: string,
		result: Pick<ImagePregenerationResult, 'width' | 'height' | 'format'>,
	) {
		return `${imageKey}:${result.width ?? 'auto'}x${result.height ?? 'auto'}:${result.format}`;
	}

	private resolveRequestedVariantFormat(
		name: string,
		requestedFormat?: ImageEntity['format'],
	) {
		const format = requestedFormat ?? normalizeImageFormat(name);
		if (format === 'png' || format === 'jpeg' || format === 'webp') {
			return format;
		}
		return undefined;
	}

	private async publishPregenerationTelemetryEvents({
		imageId,
		name,
		path,
		results,
		telemetryContext,
	}: {
		imageId?: number;
		path: string;
		name: string;
		results: ImagePregenerationResult[];
		telemetryContext: ReturnType<typeof createClientServiceTelemetryFields>;
	}) {
		const imageKey = `${path}/${name}`;
		for (const result of results) {
			const eventBase = {
				sourceApp: 'resize' as const,
				imageId,
				path,
				name,
				imageKey,
				cacheKey: this.createPreGeneratedVariantKey(imageKey, result),
				width: result.width,
				height: result.height,
				format: normalizeImageFormat(result.format),
				durationMs: result.durationMs,
				...telemetryContext,
			};

			if (result.status === 'success') {
				this.publishTelemetryEvent(
					createImageTelemetryEvent({
						...eventBase,
						eventType: ImageTelemetryEventType.ResizeCompleted,
						inputBytes: result.inputBytes ?? 0,
						outputBytes: result.outputBytes ?? 0,
						status: 'success',
					}),
				);
				continue;
			}

			this.publishTelemetryEvent(
				createImageTelemetryEvent({
					...eventBase,
					eventType: ImageTelemetryEventType.ResizeFailed,
					status: 'failed',
					...createFailedTelemetryFields(result.error),
				}),
			);
		}
	}

	private async invalidateCachedImage({
		action,
		clientServiceContext,
		name,
		path,
	}: {
		action: 'image.upload' | 'image.delete';
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

		const headers = createInternalServiceForwardHeaders(
			clientServiceContext,
			process.env.INTERNAL_API_KEY ?? this.appConfig?.INTERNAL_API_KEY,
			{ audience: 'cache', action },
		);

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
		apiInfo: Pick<UploadImageDto, 'externalImageId' | 'path'>;
	}) {
		const { apiInfo, file } = imageInfo;
		const strategy = this.getStrategyFromMimeType(file.mimetype);
		const originalName = normalizeSafeFileName(
			file.originalname,
			'original name',
		);
		const storagePath = normalizeImageStoragePath(apiInfo.path);
		const mainName = createStoredImageName(
			originalName,
			undefined,
			getMaxImageFileNameLengthForPath(storagePath),
		);

		try {
			const startTime = performance.now();
			const { format, size } = await this.imageManager.saveImageFromTemp(
				strategy,
				{
					savePath: storagePath,
					mainName,
					tempName: file.filename,
				},
			);
			const exeTime = performance.now() - startTime;

			this.logger.log(
				`[${apiInfo.externalImageId ?? 'no-external-id'}]${apiInfo.path}/${mainName} - ${format} ${file.size}>>${size}byte +${Math.round(exeTime)}ms `,
			);

			return { format, size, exeTime, name: mainName, originalName };
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
			if (
				this.isAuthoritativeImageLifecycleEnabled() &&
				this.assetLifecycle &&
				clientServiceContext?.clientServiceId
			) {
				const telemetryContext =
					createClientServiceTelemetryFields(clientServiceContext);
				try {
					const result = await this.assetLifecycle.delete({
						clientServiceId: clientServiceContext.clientServiceId,
						path: normalizeImageStoragePath(path),
						name,
					});
					if (!(result.metadataMissing && this.isImageAssetDualReadEnabled())) {
						if (result.eventId) {
							this.publishTelemetryEvent(
								createImageTelemetryEvent({
									eventId: result.eventId,
									eventType: ImageTelemetryEventType.DeleteCompleted,
									sourceApp: 'storage',
									path,
									name,
									imageKey: `${path}/${name}`,
									format: normalizeImageFormat(name),
									status: 'success',
									...telemetryContext,
								}),
							);
						}
						this.imageLifecycleMetrics?.recordDeleteCompleted(result.eventId);
						return;
					}
					this.logger.log(
						`authoritative metadata missing for ${path}/${name}; using legacy delete during dual-read transition`,
					);
				} catch (error) {
					const deleteEventId =
						error instanceof ImageAssetDeleteFailure
							? error.eventId
							: randomUUID();
					this.imageLifecycleMetrics?.recordDeleteFailed(deleteEventId, error);
					this.publishTelemetryEvent(
						createImageTelemetryEvent({
							eventId: randomUUID(),
							eventType: ImageTelemetryEventType.DeleteFailed,
							sourceApp: 'storage',
							path,
							name,
							imageKey: `${path}/${name}`,
							format: normalizeImageFormat(name),
							status: 'failed',
							...telemetryContext,
							...createFailedTelemetryFields(error),
						}),
					);
					throw error;
				}
			}
			await this.imageManager.deleteMainImage({ path, name });
			if (
				this.cacheInvalidationPublisher &&
				clientServiceContext?.clientServiceId
			) {
				const published = await this.cacheInvalidationPublisher.publish({
					eventId: randomUUID(),
					clientServiceId: clientServiceContext.clientServiceId,
					path: this.getPublicCachePath(path),
					name,
					reason: 'delete',
				});
				if (!published) {
					this.logger.warn(
						`legacy delete cache invalidation publish failed for ${path}/${name}`,
					);
				}
			}
			await this.invalidateCachedImage({
				action: 'image.delete',
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
		imageInfo: GetImageDto &
			Partial<Pick<ImageEntity, 'width' | 'height' | 'format'>>,
		clientServiceContext?: ClientServiceAuthContext,
	) {
		const { format: requestedFormat, height, name, path, width } = imageInfo;
		const telemetryContext =
			createClientServiceTelemetryFields(clientServiceContext);
		const mainPath = `${path}/image`;
		const authoritativeAsset =
			this.isAuthoritativeImageLifecycleEnabled() &&
			clientServiceContext?.clientServiceId
				? await this.imagePregenerationService.assertSourceReadable({
						clientServiceId: clientServiceContext.clientServiceId,
						path: mainPath,
						name,
					})
				: null;
		const variant =
			await this.imagePregenerationService.findPreGeneratedVariantForRequest({
				clientServiceId: clientServiceContext?.clientServiceId,
				path: mainPath,
				name,
				width,
				height,
				format: this.resolveRequestedVariantFormat(name, requestedFormat),
				authoritativeAsset: authoritativeAsset ?? undefined,
			});

		try {
			const result =
				variant ??
				(await this.imageManager.getBufferImage({
					path: mainPath,
					name,
				}));

			this.publishTelemetryEvent(
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

			return {
				...result,
				preGeneratedVariant: variant
					? {
							width: variant.width,
							height: variant.height,
							format: variant.format,
						}
					: undefined,
			};
		} catch (error) {
			this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventType: ImageTelemetryEventType.ReadFailed,
					sourceApp: 'storage',
					path,
					name,
					format: normalizeImageFormat(name),
					stage: ImageTelemetryStage.StorageRead,
					status: 'failed',
					...telemetryContext,
					...createFailedTelemetryFields(error),
				}),
			);
			throw error;
		}
	}

	private isAuthoritativeImageLifecycleEnabled() {
		return process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED !== 'false';
	}

	private isImageAssetDualReadEnabled() {
		return process.env.IMAGE_ASSET_DUAL_READ_ENABLED !== 'false';
	}

	private async uploadFileWithAuthoritativeLifecycle(input: {
		file: Express.Multer.File;
		apiInfo: UploadImageDto;
		clientServiceContext: ClientServiceAuthContext;
		idempotencyKey: string;
	}) {
		if (!this.assetLifecycle) {
			throw new Error('Authoritative image lifecycle provider is unavailable');
		}
		const { apiInfo, clientServiceContext, file, idempotencyKey } = input;
		const strategy = this.getStrategyFromMimeType(file.mimetype);
		const originalName = normalizeSafeFileName(
			file.originalname,
			'original name',
		);
		const storagePath = normalizeImageStoragePath(apiInfo.path);
		const name = createStoredImageName(
			originalName,
			createStableStoredImageSuffix(idempotencyKey),
			getMaxImageFileNameLengthForPath(storagePath),
		);
		const lifecycleResult = await this.assetLifecycle.upload(strategy, {
			idempotencyKey,
			clientServiceId: clientServiceContext.clientServiceId,
			clientServiceSlug: clientServiceContext.clientServiceSlug,
			requestId: clientServiceContext.requestId,
			traceId: clientServiceContext.traceId,
			logicalPath: storagePath,
			path: storagePath,
			name,
			originalName,
			contentType: file.mimetype,
			inputBytes: file.size,
			externalImageId: apiInfo.externalImageId,
			tempName: file.filename,
		});
		const imageKey = `${storagePath}/${name}`;
		const telemetryContext =
			createClientServiceTelemetryFields(clientServiceContext);
		this.publishTelemetryEvent(
			createImageTelemetryEvent({
				eventId: lifecycleResult.eventId,
				eventType: ImageTelemetryEventType.UploadCompleted,
				sourceApp: 'storage',
				imageId: apiInfo.externalImageId,
				path: apiInfo.path,
				name,
				originalName,
				imageKey,
				format: normalizeImageFormat(lifecycleResult.format),
				inputBytes: file.size,
				outputBytes: lifecycleResult.size,
				durationMs: lifecycleResult.durationMs,
				status: 'success',
				...telemetryContext,
			}),
		);

		let variantStatus = lifecycleResult.variantStatus;
		if (process.env.IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED === 'true') {
			const results = await this.imagePregenerationService.preGenerateForUpload(
				{
					clientServiceId: clientServiceContext.clientServiceId,
					assetId: lifecycleResult.assetId,
					sourceChecksum: lifecycleResult.checksum,
					path: apiInfo.path,
					name,
				},
			);
			if (results.length > 0) {
				variantStatus = results.every((result) => result.status === 'success')
					? 'Ready'
					: 'Failed';
			}
			await this.publishPregenerationTelemetryEvents({
				imageId: apiInfo.externalImageId,
				path: apiInfo.path,
				name,
				results,
				telemetryContext,
			});
		}

		if (this.cacheInvalidationPublisher) {
			void this.cacheInvalidationPublisher
				.publish({
					eventId: lifecycleResult.eventId,
					clientServiceId: clientServiceContext.clientServiceId,
					path: this.getPublicCachePath(apiInfo.path),
					name,
					reason: 'upload',
					assetId: lifecycleResult.assetId,
					sourceChecksum: lifecycleResult.checksum,
				})
				.then((published) => {
					if (!published)
						this.logger.warn('upload cache invalidation deferred');
				})
				.catch((error: unknown) => {
					this.logger.warn(
						`upload cache invalidation wakeup failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				});
		}

		if (apiInfo.beforeName && apiInfo.beforeName !== name) {
			await this.deleteImage({
				path: apiInfo.path,
				name: apiInfo.beforeName,
				clientServiceContext,
			});
		}

		return {
			imageKey,
			path: apiInfo.path,
			name,
			originalName,
			format: normalizeImageFormat(lifecycleResult.format),
			size: lifecycleResult.size,
			eventId: lifecycleResult.eventId,
			assetId: lifecycleResult.assetId,
			variantStatus,
		};
	}

	/** 로컬에 이미지 업로드 */
	async uploadFile(imageInfo: {
		file: Express.Multer.File;
		apiInfo: UploadImageDto;
		clientServiceContext?: ClientServiceAuthContext;
		idempotencyKey?: string;
	}) {
		const {
			apiInfo: { externalImageId, path, beforeName },
			clientServiceContext,
			file,
		} = imageInfo;
		const telemetryContext =
			createClientServiceTelemetryFields(clientServiceContext);
		const failedOriginalName = this.getTelemetryFileName(file);
		let authoritativeLifecycleAttempted = false;

		try {
			if (
				this.isAuthoritativeImageLifecycleEnabled() &&
				this.assetLifecycle &&
				clientServiceContext?.clientServiceId &&
				imageInfo.idempotencyKey
			) {
				authoritativeLifecycleAttempted = true;
				return await this.uploadFileWithAuthoritativeLifecycle({
					file,
					apiInfo: imageInfo.apiInfo,
					clientServiceContext,
					idempotencyKey: imageInfo.idempotencyKey,
				});
			}
			const { exeTime, format, name, originalName, size } =
				await this.compressAndSaveImage({
					file,
					apiInfo: { externalImageId, path },
				});
			const imageKey = `${path}/${name}`;
			const uploadEventId = randomUUID();

			await this.publishLifecycleEvent(
				createImageLifecycleEvent({
					eventId: uploadEventId,
					eventType: ImageLifecycleEventType.UploadCompleted,
					imageId: externalImageId,
					path,
					name,
					originalName,
					imageKey,
					format: normalizeImageFormat(format),
					inputBytes: file.size,
					outputBytes: size,
					durationMs: exeTime,
					status: ImageLifecycleStatus.Success,
					...telemetryContext,
				}),
			);

			this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventId: uploadEventId,
					eventType: ImageTelemetryEventType.UploadCompleted,
					sourceApp: 'storage',
					imageId: externalImageId,
					path,
					name,
					originalName,
					imageKey,
					format: normalizeImageFormat(format),
					inputBytes: file.size,
					outputBytes: size,
					durationMs: exeTime,
					status: 'success',
					...telemetryContext,
				}),
			);

			const pregenerationResults =
				await this.imagePregenerationService.preGenerateForUpload({
					clientServiceId: clientServiceContext?.clientServiceId,
					path,
					name,
				});
			await this.publishPregenerationTelemetryEvents({
				imageId: externalImageId,
				path,
				name,
				results: pregenerationResults,
				telemetryContext,
			});

			await this.invalidateCachedImage({
				action: 'image.upload',
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

			return {
				imageKey,
				path,
				name,
				originalName,
				format: normalizeImageFormat(format),
				size,
				eventId: uploadEventId,
			};
		} catch (error) {
			const failedFields = createFailedTelemetryFields(error);
			if (!authoritativeLifecycleAttempted) {
				await this.publishLifecycleEvent(
					createImageLifecycleEvent({
						eventType: ImageLifecycleEventType.UploadFailed,
						imageId: externalImageId,
						path,
						name: failedOriginalName,
						originalName: failedOriginalName,
						imageKey: `${path}/${failedOriginalName}`,
						format: normalizeImageFormat(file.originalname),
						inputBytes: file.size,
						status: ImageLifecycleStatus.Failed,
						...telemetryContext,
						...failedFields,
					}),
				);
			}

			this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventType: ImageTelemetryEventType.UploadFailed,
					sourceApp: 'storage',
					imageId: externalImageId,
					path,
					name: failedOriginalName,
					originalName: failedOriginalName,
					imageKey: `${path}/${failedOriginalName}`,
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

export const createStoredImageName = (
	originalName: string,
	suffix: string = randomUUID(),
	maximumLength = MAX_SAFE_FILE_NAME_LENGTH,
) => {
	const safeOriginalName = normalizeSafeFileName(originalName, 'original name');
	const extensionIndex = safeOriginalName.lastIndexOf('.');
	const rawExtension =
		extensionIndex > 0 ? safeOriginalName.slice(extensionIndex) : '';
	const extension =
		rawExtension.length <= 16 && /^\.[A-Za-z0-9]+$/.test(rawExtension)
			? rawExtension
			: '';
	const baseName = extension
		? safeOriginalName.slice(0, extensionIndex)
		: safeOriginalName;
	const safeSuffix = suffix.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
	if (!safeSuffix) {
		throw new BadRequestException('stored image suffix가 비어 있습니다.');
	}
	const boundedMaximumLength = Math.min(
		MAX_SAFE_FILE_NAME_LENGTH,
		Math.max(1, Math.trunc(maximumLength)),
	);
	const suffixSegment = `.${safeSuffix}${extension}`;
	const maximumBaseLength = boundedMaximumLength - suffixSegment.length;
	if (maximumBaseLength < 1) {
		throw new BadRequestException(
			'stored image filename 상한이 너무 작습니다.',
		);
	}

	return `${baseName.slice(0, maximumBaseLength)}${suffixSegment}`;
};

const createStableStoredImageSuffix = (idempotencyKey: string) =>
	createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
