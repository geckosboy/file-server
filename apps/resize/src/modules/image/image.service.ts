import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
	ClientServiceAuthContext,
	createClientServiceTelemetryFields,
	createInternalServiceForwardHeaders,
} from '@file/database';
import { lookup } from 'mime-types';
import { performance } from 'perf_hooks';

import { ImageEntity } from '@file/image-contracts';
import { fetchUpstreamBuffer } from '@file/nest-common';
import {
	createFailedTelemetryFields,
	createImageTelemetryEvent,
	ImageTelemetryEvent,
	ImageTelemetryEventType,
	normalizeImageFormat,
	publishImageTelemetryEvent,
} from './image.telemetry';
import { ImageManager } from './manager';
import { envConfig } from 'src/config';

interface StorageImageResult {
	imageBuffer: Buffer;
	contentType: string;
	preGeneratedVariantHit: boolean;
	variantName?: string;
}

@Injectable()
export class ImageService {
	private readonly logger = new Logger(ImageService.name);

	constructor(
		private readonly imageManager: ImageManager,
		@Inject('RESIZE_IMAGE_MICROSERVICE')
		private readonly imageClient: ClientKafka,
	) {}

	private publishTelemetryEvent(event: ImageTelemetryEvent): void {
		void publishImageTelemetryEvent({
			client: this.imageClient,
			event,
			logger: this.logger,
		});
	}

	private objectToQueryString(
		params: Partial<Pick<ImageEntity, 'width' | 'height' | 'format'>>,
	) {
		const searchParams = new URLSearchParams();
		if (params.width !== undefined) {
			searchParams.set('width', String(params.width));
		}
		if (params.height !== undefined) {
			searchParams.set('height', String(params.height));
		}
		if (params.format) {
			searchParams.set('format', params.format);
		}
		return searchParams.toString();
	}

	private getImageUrl({
		format,
		height,
		name,
		path,
		width,
	}: Pick<ImageEntity, 'path' | 'name'> &
		Partial<Pick<ImageEntity, 'width' | 'height' | 'format'>>) {
		const encodedPath = encodeURIComponent(path);
		const encodedName = encodeURIComponent(name);
		const queryString = this.objectToQueryString({ width, height, format });
		const suffix = queryString ? `?${queryString}` : '';
		return `${envConfig.STORAGE_SERVER}/image/${encodedPath}/${encodedName}${suffix}`;
	}

	/** 메인 서버로부터 이미지 데이터 가져오기. Buffer형태로 리턴 */
	async getImageFromMain(
		imageInfo: Pick<ImageEntity, 'path' | 'name'> &
			Partial<Pick<ImageEntity, 'width' | 'height' | 'format'>>,
		clientServiceContext?: ClientServiceAuthContext,
	): Promise<StorageImageResult> {
		const headers = createInternalServiceForwardHeaders(
			clientServiceContext,
			process.env.INTERNAL_API_KEY ?? envConfig.INTERNAL_API_KEY,
			{ audience: 'storage', action: 'image.read' },
		);
		const { body: image, response: result } = await fetchUpstreamBuffer({
			upstream: 'storage',
			url: this.getImageUrl(imageInfo),
			headers,
			requestContext: clientServiceContext,
			timeoutMs: envConfig.UPSTREAM_HTTP_TIMEOUT_MS,
			maxRetries: envConfig.UPSTREAM_HTTP_MAX_RETRIES,
			retryBackoffMs: envConfig.UPSTREAM_HTTP_RETRY_BACKOFF_MS,
			maxResponseBytes: envConfig.UPSTREAM_IMAGE_MAX_RESPONSE_BYTES,
		});
		/** 데이터가 없을 시 클라이언트에서 잘못 요청하거나 DB에 주소나 이름 값이 잘못된거임 */
		if (!image.byteLength) {
			throw new NotFoundException('존재하지 않는 파일입니다.');
		}

		return {
			imageBuffer: image,
			contentType:
				result.headers.get('content-type') ||
				lookup(imageInfo.name) ||
				'application/octet-stream',
			preGeneratedVariantHit:
				result.headers.get('x-file-server-pregenerated-variant') === 'true',
			variantName:
				result.headers.get('x-file-server-variant-name') ?? undefined,
		};
	}

	/** Width, Height으로 리사이징 */
	async resizeImage(
		imageInfo: ImageEntity,
		clientServiceContext?: ClientServiceAuthContext,
	) {
		const { path, name, ...size } = imageInfo;
		const format = imageInfo.format ?? normalizeImageFormat(name);
		const requestedAt = performance.now();
		const telemetryContext =
			createClientServiceTelemetryFields(clientServiceContext);

		this.publishTelemetryEvent(
			createImageTelemetryEvent({
				eventType: ImageTelemetryEventType.ResizeRequested,
				sourceApp: 'resize',
				path,
				name,
				format,
				width: size.width,
				height: size.height,
				status: 'success',
				...telemetryContext,
			}),
		);

		try {
			const fetchedImage = await this.getImageFromMain(
				{ path, name, ...size },
				clientServiceContext,
			);
			if (fetchedImage.preGeneratedVariantHit) {
				await this.imageManager.validate(fetchedImage.imageBuffer);
				const durationMs = performance.now() - requestedAt;
				this.logger.log(
					`${path}/${name} - pre-generated ${format} ${size.width ?? '-'}/${size.height ?? '-'}px ${fetchedImage.imageBuffer.byteLength}byte +${Math.round(durationMs)}ms `,
				);

				this.publishTelemetryEvent(
					createImageTelemetryEvent({
						eventType: ImageTelemetryEventType.ResizeCompleted,
						sourceApp: 'resize',
						path,
						name,
						cacheKey: `${path}/${name}:${size.width ?? 'auto'}x${size.height ?? 'auto'}:${format}`,
						format,
						width: size.width,
						height: size.height,
						inputBytes: fetchedImage.imageBuffer.byteLength,
						outputBytes: fetchedImage.imageBuffer.byteLength,
						durationMs,
						status: 'success',
						...telemetryContext,
					}),
				);

				return {
					imageBuffer: fetchedImage.imageBuffer,
					contentType: fetchedImage.contentType,
				};
			}
			const startTime = performance.now();

			const result = await this.imageManager.resize(
				fetchedImage.imageBuffer,
				size,
			);

			const exeTime = performance.now() - startTime;

			this.logger.log(
				`${path}/${name} - ${format} ${size.width ?? '-'}/${size.height ?? '-'}px ${fetchedImage.imageBuffer.byteLength}>>${result.byteLength}byte +${Math.round(exeTime)}ms `,
			);

			this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventType: ImageTelemetryEventType.ResizeCompleted,
					sourceApp: 'resize',
					path,
					name,
					format,
					width: size.width,
					height: size.height,
					inputBytes: fetchedImage.imageBuffer.byteLength,
					outputBytes: result.byteLength,
					durationMs: exeTime,
					status: 'success',
					...telemetryContext,
				}),
			);

			return {
				imageBuffer: result,
				contentType: imageInfo.format
					? lookup(`image.${imageInfo.format}`) || fetchedImage.contentType
					: fetchedImage.contentType,
			};
		} catch (error) {
			this.logger.error(error);
			this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventType: ImageTelemetryEventType.ResizeFailed,
					sourceApp: 'resize',
					path,
					name,
					format,
					width: size.width,
					height: size.height,
					durationMs: performance.now() - requestedAt,
					status: 'failed',
					...telemetryContext,
					...createFailedTelemetryFields(error),
				}),
			);
			throw error;
		}
	}
}
