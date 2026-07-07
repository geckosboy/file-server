jest.mock('src/config', () => ({
	envConfig: {
		RESIZING_SERVER: 'http://resize.test',
		INTERNAL_API_KEY: 'internal-test-key',
	},
}));

import { NotFoundException } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
	ClientServiceAuthContext,
	INTERNAL_API_KEY_HEADER,
	INTERNAL_CLIENT_CONTEXT_HEADER,
	INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER,
} from '@file/database';
import { of } from 'rxjs';
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
	apiKey: 'fs_prefix_secret',
};

type KafkaEmitPayload = { key: string; value: string };

const parseKafkaPayload = (payload: KafkaEmitPayload) =>
	JSON.parse(payload.value) as Record<string, unknown>;

describe('캐시 이미지 서비스', () => {
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
				cacheKey: 'public|100|x|png|sample.png',
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
		expect(fetchOptions).toEqual({
			headers: expect.objectContaining({
				[INTERNAL_API_KEY_HEADER]: 'internal-test-key',
				[INTERNAL_CLIENT_CONTEXT_HEADER]: expect.any(String),
				[INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER]: expect.any(String),
			}),
		});
		expect(JSON.stringify(fetchOptions.headers)).not.toContain(
			'fs_prefix_secret',
		);
		expect(result.contentType).toBe('image/webp');
		expect(result.imageBuffer.equals(resized)).toBe(true);
		expect(cacheService.cacheImage).toHaveBeenCalledWith(
			'public|100|x|webp|sample.webp',
			{
				imageBuffer: resized,
				contentType: 'image/webp',
			},
		);
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheMiss,
				cacheKey: 'public|100|x|webp|sample.webp',
				status: 'success',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: 'req-cache-1',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheStored,
				cacheKey: 'public|100|x|webp|sample.webp',
				outputBytes: resized.byteLength,
				status: 'success',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: 'req-cache-1',
			}),
		]);
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
			'public|100|50|webp|sample.png',
			expect.objectContaining({
				imageBuffer: resized,
				contentType: 'image/webp',
			}),
		);
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheMiss,
				cacheKey: 'public|100|50|webp|sample.png',
				format: 'webp',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheStored,
				cacheKey: 'public|100|50|webp|sample.png',
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

	it('원본 이미지 삭제 요청 시 해당 이미지의 모든 리사이즈 캐시를 삭제한다', () => {
		cacheService.deleteCachedImagesForImage.mockReturnValue(2);

		const result = service.deleteCacheImage({
			path: 'public',
			name: 'sample.png',
		});

		expect(cacheService.deleteCachedImagesForImage).toHaveBeenCalledWith({
			path: 'public',
			name: 'sample.png',
		});
		expect(result).toEqual({ deletedCount: 2 });
	});
});
