import {
	GatewayTimeoutException,
	Inject,
	Injectable,
	Logger,
	Optional,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
	ClientServiceAuthContext,
	createClientServiceTelemetryFields,
	createInternalServiceForwardHeaders,
} from '@file/database';
import { lookup } from 'mime-types';
import { performance } from 'perf_hooks';
import { URLSearchParams } from 'url';

import { ImageEntity } from '@file/image-contracts';
import { fetchUpstreamBuffer } from '@file/nest-common';
import {
	createFailedTelemetryFields,
	createImageTelemetryEvent,
	ImageTelemetryEvent,
	ImageTelemetryEventType,
	ImageTelemetryStage,
	normalizeImageFormat,
	publishImageTelemetryEvent,
} from './image.telemetry';
import { CacheService } from '../node-cache/cache.service';
import { envConfig } from 'src/config';

const DEFAULT_SINGLEFLIGHT_TIMEOUT_MS = 5_000;

export interface ImageSingleflightMetrics {
	inFlight: number;
	waiters: number;
	coalescedRequests: number;
}

interface ImageInvalidationGeneration {
	activeOrigins: number;
	value: number;
}

@Injectable()
export class ImageService {
	private readonly logger = new Logger(ImageService.name);
	private readonly singleflight = new Map<
		string,
		Promise<{ imageBuffer: Buffer; contentType: string }>
	>();
	private readonly invalidationGenerations = new Map<
		string,
		ImageInvalidationGeneration
	>();
	private readonly singleflightTimeoutMs = readPositiveInteger(
		process.env.CACHE_SINGLEFLIGHT_TIMEOUT_MS,
		DEFAULT_SINGLEFLIGHT_TIMEOUT_MS,
	);
	private singleflightWaiters = 0;
	private coalescedRequests = 0;

	constructor(
		private readonly cacheService: CacheService,
		@Optional()
		@Inject('CACHE_IMAGE_MICROSERVICE')
		private readonly imageClient?: ClientKafka,
	) {}

	private publishTelemetryEvent(event: ImageTelemetryEvent): void {
		void publishImageTelemetryEvent({
			client: this.imageClient,
			event,
			logger: this.logger,
		});
	}

	getSingleflightMetrics(): ImageSingleflightMetrics {
		return {
			inFlight: this.singleflight.size,
			waiters: this.singleflightWaiters,
			coalescedRequests: this.coalescedRequests,
		};
	}

	/** Object 형식 QueryString으로 변환 */
	private objectToQueryString(obj: Record<string, string | number>) {
		const convertedObj = Object.entries(obj).reduce(
			(acc: Record<string, string>, [key, value]) => {
				if (value) {
					acc[key] = String(value);
				}
				return acc;
			},
			{},
		);
		return new URLSearchParams(convertedObj).toString();
	}

	/** Name, path 등으로 CacheKey 생성 */
	private convertToCacheKey({
		clientServiceId,
		format,
		name,
		path,
		height,
		width,
	}: ImageEntity & { clientServiceId: string }) {
		return [
			encodeURIComponent(clientServiceId),
			encodeURIComponent(path),
			width ?? 'x',
			height ?? 'x',
			format ?? normalizeImageFormat(name),
			encodeURIComponent(name),
		].join('|');
	}

	private convertToImageIdentityKey({
		clientServiceId,
		name,
		path,
	}: Pick<ImageEntity, 'path' | 'name'> & { clientServiceId: string }) {
		return [clientServiceId, path, name]
			.map((part) => encodeURIComponent(part))
			.join('|');
	}

	private getImageUrl({ name, path, ...size }: ImageEntity) {
		const queryStr = this.objectToQueryString(size);
		const encodedPath = encodeURIComponent(path);
		const encodedName = encodeURIComponent(name);
		return `${envConfig.RESIZING_SERVER}/image/${encodedPath}/${encodedName}?${queryStr}`;
	}

	/** 리사이징 서버에 이미지 요청 */
	private async getImageFromMain(
		image: ImageEntity,
		clientServiceContext?: ClientServiceAuthContext,
	) {
		const headers = createInternalServiceForwardHeaders(
			clientServiceContext,
			process.env.INTERNAL_API_KEY ?? envConfig.INTERNAL_API_KEY,
			{ audience: 'resize', action: 'image.read' },
		);
		const imageUrl = this.getImageUrl(image);
		const { body: imageBuffer, response } = await fetchUpstreamBuffer({
			upstream: 'resize',
			url: imageUrl,
			headers,
			requestContext: clientServiceContext,
			timeoutMs: envConfig.UPSTREAM_HTTP_TIMEOUT_MS,
			maxRetries: envConfig.UPSTREAM_HTTP_MAX_RETRIES,
			retryBackoffMs: envConfig.UPSTREAM_HTTP_RETRY_BACKOFF_MS,
			maxResponseBytes: envConfig.UPSTREAM_IMAGE_MAX_RESPONSE_BYTES,
		});
		const contentType =
			response.headers.get('content-type') ||
			lookup(image.name) ||
			'application/octet-stream';

		return { imageBuffer, contentType };
	}

	async getCacheImage(
		params: ImageEntity,
		clientServiceContext?: ClientServiceAuthContext,
	) {
		if (!clientServiceContext) {
			throw new Error('클라이언트 서비스 컨텍스트가 필요합니다.');
		}
		const cacheKey = this.convertToCacheKey({
			...params,
			clientServiceId: clientServiceContext.clientServiceId,
		});
		const imageIdentityKey = this.convertToImageIdentityKey({
			clientServiceId: clientServiceContext.clientServiceId,
			path: params.path,
			name: params.name,
		});
		const telemetryContext =
			createClientServiceTelemetryFields(clientServiceContext);
		const startedAt = performance.now();
		const { format: requestedFormat, height, name, path, width } = params;
		const format = requestedFormat ?? normalizeImageFormat(name);

		const cachedImage = this.cacheService.getCachedImage(cacheKey);
		/** Caching된 이미지 있으면 그대로 반환 */
		if (cachedImage) {
			this.logger.log(`cache hit: ${JSON.stringify(params)}`);
			this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventType: ImageTelemetryEventType.CacheHit,
					sourceApp: 'cache',
					path,
					name,
					cacheKey,
					width,
					height,
					format,
					outputBytes: cachedImage.imageBuffer.byteLength,
					durationMs: performance.now() - startedAt,
					status: 'success',
					...telemetryContext,
				}),
			);
			return cachedImage;
		}

		this.publishTelemetryEvent(
			createImageTelemetryEvent({
				eventType: ImageTelemetryEventType.CacheMiss,
				sourceApp: 'cache',
				path,
				name,
				cacheKey,
				width,
				height,
				format,
				durationMs: performance.now() - startedAt,
				status: 'success',
				...telemetryContext,
			}),
		);

		/** 없다면 리사이징 서버로부터 데이터 가져옴 */
		try {
			return await this.singleflightCacheMiss(
				cacheKey,
				imageIdentityKey,
				async (isGenerationCurrent) => {
					const { imageBuffer, contentType } = await this.getImageFromMain(
						params,
						clientServiceContext,
					);
					if (isGenerationCurrent()) {
						/** 무효화 이후 완료된 오래된 리사이징 결과는 캐시에 쓰지 않음 */
						this.cacheService.cacheImage(cacheKey, {
							imageBuffer,
							contentType,
						});

						this.publishTelemetryEvent(
							createImageTelemetryEvent({
								eventType: ImageTelemetryEventType.CacheStored,
								sourceApp: 'cache',
								path,
								name,
								cacheKey,
								width,
								height,
								format,
								outputBytes: imageBuffer.byteLength,
								durationMs: performance.now() - startedAt,
								status: 'success',
								...telemetryContext,
							}),
						);
					}

					this.logger.log(`cache not hit: ${JSON.stringify(params)}`);
					return { imageBuffer, contentType };
				},
			);
		} catch (err) {
			this.logger.error(err);
			this.publishTelemetryEvent(
				createImageTelemetryEvent({
					eventType: ImageTelemetryEventType.ReadFailed,
					sourceApp: 'cache',
					path,
					name,
					cacheKey,
					width,
					height,
					format,
					durationMs: performance.now() - startedAt,
					stage: ImageTelemetryStage.CacheOriginFetch,
					status: 'failed',
					...telemetryContext,
					...createFailedTelemetryFields(err),
				}),
			);
			throw err;
		}
	}

	private singleflightCacheMiss(
		cacheKey: string,
		imageIdentityKey: string,
		loader: (
			isGenerationCurrent: () => boolean,
		) => Promise<{ imageBuffer: Buffer; contentType: string }>,
	): Promise<{ imageBuffer: Buffer; contentType: string }> {
		const generation = this.acquireInvalidationGeneration(imageIdentityKey);
		const generationValue = generation.value;
		const singleflightKey = `${generationValue}:${cacheKey}`;
		const existing = this.singleflight.get(singleflightKey);
		if (existing) {
			this.coalescedRequests += 1;
			this.singleflightWaiters += 1;
			return existing.finally(() => {
				this.singleflightWaiters = Math.max(0, this.singleflightWaiters - 1);
			});
		}

		generation.activeOrigins += 1;
		const origin = Promise.resolve().then(() =>
			loader(() => generation.value === generationValue),
		);
		void origin.then(
			() => this.releaseInvalidationGeneration(imageIdentityKey, generation),
			() => this.releaseInvalidationGeneration(imageIdentityKey, generation),
		);
		const tracked = this.withSingleflightTimeout(origin).finally(() => {
			if (this.singleflight.get(singleflightKey) === tracked) {
				this.singleflight.delete(singleflightKey);
			}
		});
		this.singleflight.set(singleflightKey, tracked);
		return tracked;
	}

	private acquireInvalidationGeneration(
		imageIdentityKey: string,
	): ImageInvalidationGeneration {
		const existing = this.invalidationGenerations.get(imageIdentityKey);
		if (existing) {
			return existing;
		}

		const created = { activeOrigins: 0, value: 0 };
		this.invalidationGenerations.set(imageIdentityKey, created);
		return created;
	}

	private releaseInvalidationGeneration(
		imageIdentityKey: string,
		generation: ImageInvalidationGeneration,
	): void {
		generation.activeOrigins = Math.max(0, generation.activeOrigins - 1);
		if (
			generation.activeOrigins === 0 &&
			this.invalidationGenerations.get(imageIdentityKey) === generation
		) {
			this.invalidationGenerations.delete(imageIdentityKey);
		}
	}

	private withSingleflightTimeout<T>(promise: Promise<T>): Promise<T> {
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<T>((_resolve, reject) => {
			timeoutHandle = setTimeout(
				() =>
					reject(
						new GatewayTimeoutException(
							'캐시 원본 조회 대기가 시간 초과되었습니다.',
						),
					),
				this.singleflightTimeoutMs,
			);
		});

		return Promise.race([promise, timeout]).finally(() => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
		});
	}

	deleteCacheImage(
		params: Pick<ImageEntity, 'path' | 'name'> & { clientServiceId: string },
	) {
		const imageIdentityKey = this.convertToImageIdentityKey(params);
		const generation = this.invalidationGenerations.get(imageIdentityKey);
		if (generation) {
			generation.value += 1;
		}
		const deletedCount = this.cacheService.deleteCachedImagesForImage(params);

		this.logger.log(
			`cache invalidate: ${JSON.stringify(params)} deleted=${deletedCount}`,
		);

		return { deletedCount };
	}
}

function readPositiveInteger(
	value: string | undefined,
	fallback: number,
): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
