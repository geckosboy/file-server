jest.mock('src/config', () => ({
	envConfig: {
		STORAGE_SERVER: 'http://storage.test',
	},
}));

import {
	InternalServerErrorException,
	NotFoundException,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { ClientServiceAuthContext } from '@file/database';
import { of } from 'rxjs';
import { ImageManager } from './manager';
import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEventType,
} from './image.telemetry';
import { ImageService } from './image.service';

const createFetchResponse = (body: Buffer, status = 200) =>
	new Response(new Uint8Array(body), { status });

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
			{
				method: 'get',
				headers: {
					'x-client-api-key': 'fs_prefix_secret',
					'x-request-id': 'req-resize-1',
				},
			},
		);
		expect(result.equals(originalImage)).toBe(true);
	});

	it('스토리지 앱이 404를 반환하면 NotFoundException을 던진다', async () => {
		fetchSpy.mockResolvedValue(
			createFetchResponse(Buffer.from('missing'), 404),
		);

		await expect(
			service.getImageFromMain({ path: 'public', name: 'missing.png' }),
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('스토리지 앱이 404가 아닌 오류를 반환하면 InternalServerErrorException을 던진다', async () => {
		fetchSpy.mockResolvedValue(createFetchResponse(Buffer.from('error'), 500));

		await expect(
			service.getImageFromMain({ path: 'public', name: 'error.png' }),
		).rejects.toBeInstanceOf(InternalServerErrorException);
	});

	it('스토리지 앱이 빈 본문을 반환하면 NotFoundException을 던진다', async () => {
		fetchSpy.mockResolvedValue(createFetchResponse(Buffer.alloc(0)));

		await expect(
			service.getImageFromMain({ path: 'public', name: 'empty.png' }),
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('원본 이미지를 가져온 뒤 ImageManager에 리사이징을 위임한다', async () => {
		const originalImage = Buffer.from('original-image');
		const resizedImage = Buffer.from('resized-image');
		jest.spyOn(service, 'getImageFromMain').mockResolvedValue(originalImage);
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
			},
			clientServiceContext,
		);
		expect(imageManager.resize).toHaveBeenCalledWith(originalImage, {
			width: 100,
			height: 50,
		});
		expect(result).toBe(resizedImage);
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
