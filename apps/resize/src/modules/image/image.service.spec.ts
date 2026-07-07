jest.mock('src/config', () => ({
	envConfig: {
		STORAGE_SERVER: 'http://storage.test',
		INTERNAL_API_KEY: 'internal-test-key',
	},
}));

import {
	InternalServerErrorException,
	NotFoundException,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
	ClientServiceAuthContext,
	INTERNAL_API_KEY_HEADER,
	INTERNAL_CLIENT_CONTEXT_HEADER,
	INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER,
} from '@file/database';
import { of } from 'rxjs';
import { ImageManager } from './manager';
import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEventType,
} from './image.telemetry';
import { ImageService } from './image.service';

const createFetchResponse = (
	body: Buffer,
	options: { status?: number; headers?: HeadersInit } = {},
) =>
	new Response(new Uint8Array(body), {
		status: options.status ?? 200,
		headers: options.headers,
	});

const clientServiceContext: ClientServiceAuthContext = {
	clientServiceId: 'service-1',
	clientServiceSlug: 'local-demo',
	clientServiceName: 'Local Demo',
	clientServiceKeyId: 'key-1',
	keyPrefix: 'prefix-1',
	requestId: 'req-resize-1',
	apiKey: 'fs_prefix_secret',
};

type KafkaEmitPayload = { key: string; value: string };

const parseKafkaPayload = (payload: KafkaEmitPayload) =>
	JSON.parse(payload.value) as Record<string, unknown>;

describe('리사이즈 이미지 서비스', () => {
	let imageManager: jest.Mocked<Pick<ImageManager, 'resize'>>;
	let service: ImageService;
	let imageClient: jest.Mocked<Pick<ClientKafka, 'emit'>>;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;

	const getTelemetryPayloads = () =>
		imageClient.emit.mock.calls
			.filter(([topic]) => topic === IMAGE_TELEMETRY_TOPIC)
			.map(([, payload]) => parseKafkaPayload(payload as KafkaEmitPayload));

	beforeEach(() => {
		imageManager = {
			resize: jest.fn(),
		};
		imageClient = {
			emit: jest.fn().mockReturnValue(of({ ok: true })),
		};
		service = new ImageService(
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
		);
		fetchSpy = jest.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('스토리지 앱에서 원본 이미지를 버퍼로 가져온다', async () => {
		const originalImage = Buffer.from('original-image');
		fetchSpy.mockResolvedValue(createFetchResponse(originalImage));

		const result = await service.getImageFromMain(
			{
				path: 'public',
				name: 'sample.png',
			},
			clientServiceContext,
		);

		expect(fetchSpy).toHaveBeenCalledWith(
			'http://storage.test/image/public/sample.png',
			expect.any(Object),
		);
		const fetchOptions = fetchSpy.mock.calls[0][1] as RequestInit;
		expect(fetchOptions).toEqual({
			method: 'get',
			headers: expect.objectContaining({
				[INTERNAL_API_KEY_HEADER]: 'internal-test-key',
				[INTERNAL_CLIENT_CONTEXT_HEADER]: expect.any(String),
				[INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER]: expect.any(String),
			}),
		});
		expect(JSON.stringify(fetchOptions.headers)).not.toContain(
			'fs_prefix_secret',
		);
		expect(result.imageBuffer.equals(originalImage)).toBe(true);
		expect(result.contentType).toBe('image/png');
		expect(result.preGeneratedVariantHit).toBe(false);
	});

	it('스토리지 앱이 404를 반환하면 NotFoundException을 던진다', async () => {
		fetchSpy.mockResolvedValue(
			createFetchResponse(Buffer.from('missing'), { status: 404 }),
		);

		await expect(
			service.getImageFromMain(
				{ path: 'public', name: 'missing.png' },
				clientServiceContext,
			),
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('스토리지 앱이 404가 아닌 오류를 반환하면 InternalServerErrorException을 던진다', async () => {
		fetchSpy.mockResolvedValue(
			createFetchResponse(Buffer.from('error'), { status: 500 }),
		);

		await expect(
			service.getImageFromMain(
				{ path: 'public', name: 'error.png' },
				clientServiceContext,
			),
		).rejects.toBeInstanceOf(InternalServerErrorException);
	});

	it('스토리지 앱이 빈 본문을 반환하면 NotFoundException을 던진다', async () => {
		fetchSpy.mockResolvedValue(createFetchResponse(Buffer.alloc(0)));

		await expect(
			service.getImageFromMain(
				{ path: 'public', name: 'empty.png' },
				clientServiceContext,
			),
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('원본 이미지를 가져온 뒤 ImageManager에 리사이징을 위임한다', async () => {
		const originalImage = Buffer.from('original-image');
		const resizedImage = Buffer.from('resized-image');
		jest.spyOn(service, 'getImageFromMain').mockResolvedValue({
			imageBuffer: originalImage,
			contentType: 'image/png',
			preGeneratedVariantHit: false,
		});
		imageManager.resize.mockResolvedValue(resizedImage);

		const result = await service.resizeImage(
			{
				path: 'public',
				name: 'sample.png',
				width: 100,
				height: 50,
			},
			clientServiceContext,
		);

		expect(service.getImageFromMain).toHaveBeenCalledWith(
			{
				path: 'public',
				name: 'sample.png',
				width: 100,
				height: 50,
			},
			clientServiceContext,
		);
		expect(imageManager.resize).toHaveBeenCalledWith(originalImage, {
			width: 100,
			height: 50,
		});
		expect(result).toEqual({
			imageBuffer: resizedImage,
			contentType: 'image/png',
		});
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeRequested,
				sourceApp: 'resize',
				path: 'public',
				name: 'sample.png',
				width: 100,
				height: 50,
				status: 'success',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: 'req-resize-1',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeCompleted,
				inputBytes: originalImage.byteLength,
				outputBytes: resizedImage.byteLength,
				status: 'success',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: 'req-resize-1',
			}),
		]);
	});

	it('사전 생성 variant가 없고 format이 있으면 on-demand 리사이징에서 포맷을 변환한다', async () => {
		const originalImage = Buffer.from('original-image');
		const resizedImage = Buffer.from('resized-webp-image');
		jest.spyOn(service, 'getImageFromMain').mockResolvedValue({
			imageBuffer: originalImage,
			contentType: 'image/png',
			preGeneratedVariantHit: false,
		});
		imageManager.resize.mockResolvedValue(resizedImage);

		const result = await service.resizeImage(
			{
				path: 'public',
				name: 'sample.png',
				width: 100,
				height: 50,
				format: 'webp',
			},
			clientServiceContext,
		);

		expect(imageManager.resize).toHaveBeenCalledWith(originalImage, {
			width: 100,
			height: 50,
			format: 'webp',
		});
		expect(result).toEqual({
			imageBuffer: resizedImage,
			contentType: 'image/webp',
		});
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeRequested,
				format: 'webp',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeCompleted,
				format: 'webp',
				inputBytes: originalImage.byteLength,
				outputBytes: resizedImage.byteLength,
				status: 'success',
			}),
		]);
	});

	it('스토리지에서 pre-generated variant를 받으면 on-demand 리사이징을 건너뛴다', async () => {
		const variantImage = Buffer.from('variant-image');
		fetchSpy.mockResolvedValue(
			createFetchResponse(variantImage, {
				headers: {
					'content-type': 'image/webp',
					'x-file-server-pregenerated-variant': 'true',
					'x-file-server-variant-name': 'sample__w100_h50.webp',
				},
			}),
		);

		const result = await service.resizeImage(
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
			'http://storage.test/image/public/sample.png?width=100&height=50&format=webp',
			expect.any(Object),
		);
		expect(imageManager.resize).not.toHaveBeenCalled();
		expect(result).toEqual({
			imageBuffer: variantImage,
			contentType: 'image/webp',
		});
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeRequested,
				format: 'webp',
				width: 100,
				height: 50,
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeCompleted,
				cacheKey: 'public/sample.png:100x50:webp',
				format: 'webp',
				inputBytes: variantImage.byteLength,
				outputBytes: variantImage.byteLength,
				status: 'success',
			}),
		]);
	});

	it('원본 조회 실패 시 리사이즈 실패 텔레메트리 이벤트를 발행하고 예외를 유지한다', async () => {
		jest
			.spyOn(service, 'getImageFromMain')
			.mockRejectedValue(new NotFoundException('missing'));

		await expect(
			service.resizeImage({
				path: 'public',
				name: 'missing.png',
				width: 100,
			}),
		).rejects.toBeInstanceOf(NotFoundException);

		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeRequested,
				status: 'success',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeFailed,
				status: 'failed',
				errorCode: 'NotFoundException',
			}),
		]);
	});
});
