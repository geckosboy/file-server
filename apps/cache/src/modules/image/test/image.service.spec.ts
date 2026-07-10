jest.mock('src/config', () => ({
	envConfig: {
		RESIZING_SERVER: 'http://resize.test',
		INTERNAL_API_KEY: 'internal-test-key',
		UPSTREAM_HTTP_TIMEOUT_MS: 20,
		UPSTREAM_HTTP_MAX_RETRIES: 1,
		UPSTREAM_HTTP_RETRY_BACKOFF_MS: 0,
		UPSTREAM_IMAGE_MAX_RESPONSE_BYTES: 1_024,
	},
}));

import {
	BadGatewayException,
	GatewayTimeoutException,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
	ClientServiceAuthContext,
	INTERNAL_API_KEY_HEADER,
	INTERNAL_CLIENT_CONTEXT_HEADER,
	INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER,
} from '@file/database';
import { of } from 'rxjs';
import {
	getUpstreamFetchMetricsSnapshot,
	resetUpstreamFetchMetricsForTesting,
} from '@file/nest-common';
import { CacheService, CachedImage } from '../../node-cache/cache.service';
import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEventType,
} from '.././image.telemetry';
import { ImageService } from '.././image.service';

const createFetchResponse = (
	body: Buffer,
	options: { status?: number; contentType?: string } = {},
) =>
	new Response(new Uint8Array(body), {
		status: options.status ?? 200,
		headers: options.contentType
			? { 'content-type': options.contentType }
			: undefined,
	});

const clientServiceContext: ClientServiceAuthContext = {
	clientServiceId: 'service-1',
	clientServiceSlug: 'local-demo',
	clientServiceName: 'Local Demo',
	clientServiceKeyId: 'key-1',
	keyPrefix: 'prefix-1',
	requestId: 'req-cache-1',
	traceId: 'trace-cache-1',
};

type KafkaEmitPayload = { key: string; value: string };

const parseKafkaPayload = (payload: KafkaEmitPayload) =>
	JSON.parse(payload.value) as Record<string, unknown>;

describe('캐시 이미지 서비스', () => {
	const originalSingleflightTimeout = process.env.CACHE_SINGLEFLIGHT_TIMEOUT_MS;
	let cacheService: jest.Mocked<
		Pick<
			CacheService,
			'getCachedImage' | 'cacheImage' | 'deleteCachedImagesForImage'
		>
	>;
	let service: ImageService;
	let imageClient: jest.Mocked<Pick<ClientKafka, 'emit'>>;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;

	const getTelemetryPayloads = () =>
		imageClient.emit.mock.calls
			.filter(([topic]) => topic === IMAGE_TELEMETRY_TOPIC)
			.map(([, payload]) => parseKafkaPayload(payload as KafkaEmitPayload));

	beforeEach(() => {
		resetUpstreamFetchMetricsForTesting();
		cacheService = {
			getCachedImage: jest.fn(),
			cacheImage: jest.fn(),
			deleteCachedImagesForImage: jest.fn(),
		};
		imageClient = {
			emit: jest.fn().mockReturnValue(of({ ok: true })),
		};
		service = new ImageService(
			cacheService as unknown as CacheService,
			imageClient as unknown as ClientKafka,
		);
		fetchSpy = jest.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		jest.useRealTimers();
		if (originalSingleflightTimeout === undefined) {
			delete process.env.CACHE_SINGLEFLIGHT_TIMEOUT_MS;
		} else {
			process.env.CACHE_SINGLEFLIGHT_TIMEOUT_MS = originalSingleflightTimeout;
		}
		jest.restoreAllMocks();
	});

	it('캐시된 이미지가 있으면 리사이즈 앱에 요청하지 않고 반환한다', async () => {
		const cachedImage: CachedImage = {
			imageBuffer: Buffer.from('cached'),
			contentType: 'image/png',
		};
		cacheService.getCachedImage.mockReturnValue(cachedImage);

		const result = await service.getCacheImage(
			{
				path: 'public',
				name: 'sample.png',
				width: 100,
			},
			clientServiceContext,
		);

		expect(result).toBe(cachedImage);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(cacheService.cacheImage).not.toHaveBeenCalled();
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheHit,
				sourceApp: 'cache',
				path: 'public',
				name: 'sample.png',
				cacheKey: 'service-1|public|100|x|png|sample.png',
				width: 100,
				format: 'png',
				outputBytes: cachedImage.imageBuffer.byteLength,
				status: 'success',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: 'req-cache-1',
			}),
		]);
	});

	it('캐시가 없으면 리사이즈 앱에 요청하고 응답을 저장한 뒤 반환한다', async () => {
		const resized = Buffer.from('resized-image');
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockResolvedValue(
			createFetchResponse(resized, { contentType: 'image/webp' }),
		);

		const result = await service.getCacheImage(
			{
				path: 'public',
				name: 'sample.webp',
				width: 100,
			},
			clientServiceContext,
		);

		expect(fetchSpy).toHaveBeenCalledWith(
			'http://resize.test/image/public/sample.webp?width=100',
			expect.any(Object),
		);
		const fetchOptions = fetchSpy.mock.calls[0][1] as RequestInit;
		const forwardedHeaders = new Headers(fetchOptions.headers);
		expect(fetchOptions.method).toBe('GET');
		expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
		expect(forwardedHeaders.get(INTERNAL_API_KEY_HEADER)).toBe(
			'internal-test-key',
		);
		expect(forwardedHeaders.get(INTERNAL_CLIENT_CONTEXT_HEADER)).toEqual(
			expect.any(String),
		);
		expect(
			forwardedHeaders.get(INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER),
		).toEqual(expect.any(String));
		expect(forwardedHeaders.get('x-request-id')).toBe('req-cache-1');
		expect(forwardedHeaders.get('x-trace-id')).toBe('trace-cache-1');
		expect(JSON.stringify(fetchOptions.headers)).not.toContain(
			'fs_prefix_secret',
		);
		expect(result.contentType).toBe('image/webp');
		expect(result.imageBuffer.equals(resized)).toBe(true);
		expect(getUpstreamFetchMetricsSnapshot().resize).toEqual({
			requestCount: 1,
			timeoutCount: 0,
			transportFailureCount: 0,
			finalStatusCounts: { '200': 1 },
		});
		expect(cacheService.cacheImage).toHaveBeenCalledWith(
			'service-1|public|100|x|webp|sample.webp',
			{
				imageBuffer: resized,
				contentType: 'image/webp',
			},
		);
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheMiss,
				cacheKey: 'service-1|public|100|x|webp|sample.webp',
				status: 'success',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: 'req-cache-1',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheStored,
				cacheKey: 'service-1|public|100|x|webp|sample.webp',
				outputBytes: resized.byteLength,
				status: 'success',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: 'req-cache-1',
			}),
		]);
	});

	it('동일 tenant/image/variant 100개의 동시 miss를 하나의 resize 요청으로 합친다', async () => {
		const resized = Buffer.from('singleflight-image');
		cacheService.getCachedImage.mockReturnValue(undefined);
		let resolveFetch: ((response: Response) => void) | undefined;
		fetchSpy.mockReturnValue(
			new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			}),
		);

		const requests = Array.from({ length: 100 }, () =>
			service.getCacheImage(
				{ path: 'public', name: 'sample.png', width: 100, format: 'webp' },
				clientServiceContext,
			),
		);
		await Promise.resolve();
		await Promise.resolve();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(service.getSingleflightMetrics()).toEqual({
			inFlight: 1,
			waiters: 99,
			coalescedRequests: 99,
		});

		resolveFetch?.(createFetchResponse(resized, { contentType: 'image/webp' }));
		const results = await Promise.all(requests);

		expect(cacheService.cacheImage).toHaveBeenCalledTimes(1);
		expect(results).toHaveLength(100);
		expect(results.every((result) => result === results[0])).toBe(true);
		expect(service.getSingleflightMetrics()).toEqual({
			inFlight: 0,
			waiters: 0,
			coalescedRequests: 99,
		});
	});

	it('tenant나 variant가 다른 miss는 서로 다른 singleflight로 처리한다', async () => {
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockImplementation(async () =>
			createFetchResponse(Buffer.from('resized'), {
				contentType: 'image/webp',
			}),
		);
		const otherClient = {
			...clientServiceContext,
			clientServiceId: 'service-2',
			clientServiceKeyId: 'key-2',
		};

		await Promise.all([
			service.getCacheImage(
				{ path: 'public', name: 'sample.png', width: 100 },
				clientServiceContext,
			),
			service.getCacheImage(
				{ path: 'public', name: 'sample.png', width: 100 },
				clientServiceContext,
			),
			service.getCacheImage(
				{ path: 'public', name: 'sample.png', width: 200 },
				clientServiceContext,
			),
			service.getCacheImage(
				{ path: 'public', name: 'sample.png', width: 100 },
				otherClient,
			),
		]);

		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect(cacheService.cacheImage).toHaveBeenCalledTimes(3);
	});

	it('singleflight 실패 후 pending 항목을 제거해 다음 요청이 재시도한다', async () => {
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy
			.mockRejectedValueOnce(new Error('resize connection reset'))
			.mockRejectedValueOnce(new Error('resize connection reset'))
			.mockResolvedValueOnce(
				createFetchResponse(Buffer.from('recovered'), {
					contentType: 'image/png',
				}),
			);

		await expect(
			service.getCacheImage(
				{ path: 'public', name: 'sample.png' },
				clientServiceContext,
			),
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(service.getSingleflightMetrics().inFlight).toBe(0);

		await expect(
			service.getCacheImage(
				{ path: 'public', name: 'sample.png' },
				clientServiceContext,
			),
		).resolves.toMatchObject({ contentType: 'image/png' });
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect(cacheService.cacheImage).toHaveBeenCalledTimes(1);
	});

	it('singleflight 대기 timeout 후에도 pending 항목을 제거해 재시도한다', async () => {
		jest.useFakeTimers();
		process.env.CACHE_SINGLEFLIGHT_TIMEOUT_MS = '10';
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockReturnValueOnce(new Promise<Response>(() => undefined));
		const timeoutService = new ImageService(
			cacheService as unknown as CacheService,
			imageClient as unknown as ClientKafka,
		);
		const timedOutRequest = timeoutService.getCacheImage(
			{ path: 'public', name: 'sample.png' },
			clientServiceContext,
		);
		const timeoutExpectation = expect(timedOutRequest).rejects.toBeInstanceOf(
			GatewayTimeoutException,
		);
		await Promise.resolve();
		await jest.advanceTimersByTimeAsync(10);
		await timeoutExpectation;
		expect(timeoutService.getSingleflightMetrics().inFlight).toBe(0);

		fetchSpy.mockResolvedValueOnce(
			createFetchResponse(Buffer.from('retry'), { contentType: 'image/png' }),
		);
		await expect(
			timeoutService.getCacheImage(
				{ path: 'public', name: 'sample.png' },
				clientServiceContext,
			),
		).resolves.toMatchObject({ contentType: 'image/png' });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it('format 쿼리를 리사이즈 앱으로 전달하고 캐시 키에도 포함한다', async () => {
		const resized = Buffer.from('pre-generated-webp');
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockResolvedValue(
			createFetchResponse(resized, { contentType: 'image/webp' }),
		);

		await service.getCacheImage(
			{
				path: 'public',
				name: 'sample.png',
				width: 100,
				height: 50,
				format: 'webp',
			},
			clientServiceContext,
		);

		expect(fetchSpy).toHaveBeenCalledWith(
			'http://resize.test/image/public/sample.png?width=100&height=50&format=webp',
			expect.any(Object),
		);
		expect(cacheService.cacheImage).toHaveBeenCalledWith(
			'service-1|public|100|50|webp|sample.png',
			expect.objectContaining({
				imageBuffer: resized,
				contentType: 'image/webp',
			}),
		);
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheMiss,
				cacheKey: 'service-1|public|100|50|webp|sample.png',
				format: 'webp',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheStored,
				cacheKey: 'service-1|public|100|50|webp|sample.png',
				format: 'webp',
			}),
		]);
	});

	it('리사이즈 앱이 콘텐츠 타입을 주지 않으면 파일 확장자를 대체값으로 사용한다', async () => {
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockResolvedValue(createFetchResponse(Buffer.from('jpeg-image')));

		const result = await service.getCacheImage(
			{
				path: 'public',
				name: 'sample.jpg',
			},
			clientServiceContext,
		);

		expect(result.contentType).toBe('image/jpeg');
	});

	it('리사이즈 앱에서 이미지를 찾지 못하면 NotFoundException을 던진다', async () => {
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockResolvedValue(
			createFetchResponse(Buffer.from('not-found'), { status: 404 }),
		);

		await expect(
			service.getCacheImage(
				{ path: 'public', name: 'missing.png' },
				clientServiceContext,
			),
		).rejects.toBeInstanceOf(NotFoundException);
		expect(cacheService.cacheImage).not.toHaveBeenCalled();
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheMiss,
				status: 'success',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ReadFailed,
				status: 'failed',
				errorCode: 'NotFoundException',
			}),
		]);
	});

	it.each([
		[401, UnauthorizedException, 401],
		[500, BadGatewayException, 502],
		[503, ServiceUnavailableException, 503],
	] as const)(
		'리사이즈 upstream %i 상태를 정확한 예외로 유지한다',
		async (status, Exception, expectedStatus) => {
			cacheService.getCachedImage.mockReturnValue(undefined);
			fetchSpy.mockResolvedValue(
				createFetchResponse(Buffer.from('upstream-error'), { status }),
			);

			const request = service.getCacheImage(
				{ path: 'public', name: 'error.png' },
				clientServiceContext,
			);
			await expect(request).rejects.toBeInstanceOf(Exception);
			await expect(request).rejects.toMatchObject({ status: expectedStatus });
			expect(fetchSpy).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
		},
	);

	it('리사이즈 upstream이 응답하지 않으면 deadline 안에 504로 종료한다', async () => {
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal;
					signal?.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					});
				}),
		);

		await expect(
			service.getCacheImage(
				{ path: 'public', name: 'hung.png' },
				clientServiceContext,
			),
		).rejects.toBeInstanceOf(GatewayTimeoutException);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('리사이즈 upstream 응답이 byte 한도를 넘으면 cache에 저장하지 않는다', async () => {
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockResolvedValue(createFetchResponse(Buffer.alloc(1_025)));

		await expect(
			service.getCacheImage(
				{ path: 'public', name: 'large.png' },
				clientServiceContext,
			),
		).rejects.toBeInstanceOf(BadGatewayException);
		expect(cacheService.cacheImage).not.toHaveBeenCalled();
	});

	it('원본 이미지 삭제 요청 시 해당 이미지의 모든 리사이즈 캐시를 삭제한다', () => {
		cacheService.deleteCachedImagesForImage.mockReturnValue(2);

		const result = service.deleteCacheImage({
			clientServiceId: 'service-1',
			path: 'public',
			name: 'sample.png',
		});

		expect(cacheService.deleteCachedImagesForImage).toHaveBeenCalledWith({
			clientServiceId: 'service-1',
			path: 'public',
			name: 'sample.png',
		});
		expect(result).toEqual({ deletedCount: 2 });
	});
});
