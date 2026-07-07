import { ClientKafka } from '@nestjs/microservices';
import { ClientServiceAuthContext } from '@file/database';
import { Readable } from 'stream';
import { of, throwError } from 'rxjs';
import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEventType,
} from '.././image.telemetry';
import {
	createLifecycleKafkaKey,
	IMAGE_LIFECYCLE_TOPIC,
	ImageLifecycleEvent,
	ImageLifecycleEventType,
} from '.././image.lifecycle';
import { ImageLifecycleOutboxService } from '.././image-lifecycle-outbox.service';
import {
	ImagePregenerationResult,
	ImagePregenerationService,
} from '.././image-pregeneration.service';
import { JpegStrategy } from '.././strategies/sharp/jpeg.strategy';
import { PngStrategy } from '.././strategies/sharp/png.strategy';
import { ImageManager } from '.././strategies/manager';
import { createStoredImageName, ImageService } from '.././image.service';
import { AppConfig } from 'src/config/env.schema';

type KafkaEmitPayload = { key: string; value: string };

const parseKafkaPayload = (payload: KafkaEmitPayload) =>
	JSON.parse(payload.value) as Record<string, unknown>;

const clientServiceContext: ClientServiceAuthContext = {
	clientServiceId: 'service-1',
	clientServiceSlug: 'local-demo',
	clientServiceName: 'Local Demo',
	clientServiceKeyId: 'key-1',
	keyPrefix: 'prefix-1',
	requestId: 'req-storage-1',
	traceId: 'trace-storage-1',
	apiKey: 'fs_prefix_secret',
};

const createMulterFile = (overrides: Partial<Express.Multer.File> = {}) => {
	const buffer = Buffer.from('file-buffer');

	return {
		fieldname: 'file',
		originalname: 'sample.png',
		encoding: '7bit',
		mimetype: 'image/png',
		size: buffer.byteLength,
		destination: '/tmp',
		filename: 'temp-file.png',
		path: '/tmp/temp-file.png',
		buffer,
		stream: Readable.from(buffer),
		...overrides,
	} as Express.Multer.File;
};

describe('스토리지 이미지 서비스', () => {
	let imageManager: jest.Mocked<
		Pick<
			ImageManager,
			| 'saveImageFromTemp'
			| 'deleteMainImage'
			| 'deleteTempImage'
			| 'getBufferImage'
		>
	>;
	let imageClient: jest.Mocked<Pick<ClientKafka, 'emit'>>;
	let lifecycleOutbox: jest.Mocked<
		Pick<ImageLifecycleOutboxService, 'enqueueAndPublish'>
	>;
	let imagePregenerationService: jest.Mocked<
		Pick<
			ImagePregenerationService,
			'preGenerateForUpload' | 'findPreGeneratedVariantForRequest'
		>
	>;
	let service: ImageService;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;

	const getEmittedMessage = (topic: string) => {
		const call = imageClient.emit.mock.calls.find(
			([emittedTopic]) => emittedTopic === topic,
		);
		if (!call) {
			throw new Error(`${topic} 발행 내역이 없습니다.`);
		}

		return call[1] as KafkaEmitPayload;
	};
	const getEmittedMessages = (topic: string) =>
		imageClient.emit.mock.calls
			.filter(([emittedTopic]) => emittedTopic === topic)
			.map(([, payload]) => payload as KafkaEmitPayload);
	const getSavedMainName = () =>
		(
			imageManager.saveImageFromTemp.mock.calls.at(-1)?.[1] as {
				mainName: string;
			}
		).mainName;

	beforeEach(() => {
		imageManager = {
			saveImageFromTemp: jest.fn().mockResolvedValue({
				format: 'png',
				size: 128,
			}),
			deleteMainImage: jest.fn().mockResolvedValue(undefined),
			deleteTempImage: jest.fn().mockResolvedValue(undefined),
			getBufferImage: jest.fn(),
		};
		imageClient = {
			emit: jest.fn().mockReturnValue(of({ ok: true })),
		};
		lifecycleOutbox = {
			enqueueAndPublish: jest.fn(async (event: ImageLifecycleEvent) => {
				imageClient.emit(IMAGE_LIFECYCLE_TOPIC, {
					key: createLifecycleKafkaKey(event),
					value: JSON.stringify(event),
				});
			}),
		};
		imagePregenerationService = {
			preGenerateForUpload: jest.fn().mockResolvedValue([]),
			findPreGeneratedVariantForRequest: jest.fn().mockResolvedValue(null),
		};
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
			lifecycleOutbox as unknown as ImageLifecycleOutboxService,
			imagePregenerationService as unknown as ImagePregenerationService,
		);
		fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('업로드된 PNG를 원본 파일명 기반 고유 파일명으로 압축해 저장한다', async () => {
		const file = createMulterFile({
			originalname: 'original name.png',
			filename: 'temp-name.png',
		});

		const result = await service.compressAndSaveImage({
			file,
			apiInfo: { externalImageId: 10, path: 'products/image' },
		});

		const savedName = getSavedMainName();
		expect(result.format).toBe('png');
		expect(result.originalName).toBe('original_name.png');
		expect(result.name).toBe(savedName);
		expect(savedName).toMatch(
			/^original_name\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
		);
		expect(imageManager.saveImageFromTemp).toHaveBeenCalledWith(
			expect.any(PngStrategy),
			{
				mainName: savedName,
				tempName: 'temp-name.png',
				savePath: 'products/image',
			},
		);
	});

	it('고유 저장 파일명은 확장자 앞에 suffix를 붙인다', () => {
		expect(createStoredImageName('sample.png', 'fixed-id')).toBe(
			'sample.fixed-id.png',
		);
	});

	it('파일 업로드 후 lifecycle/telemetry를 발행하고 이전 이미지와 임시 파일을 정리한다', async () => {
		const file = createMulterFile();

		await service.uploadFile({
			file,
			apiInfo: {
				externalImageId: 10,
				path: 'products/image',
				beforeName: 'previous.png',
			},
		});

		expect(getEmittedMessage(IMAGE_LIFECYCLE_TOPIC).key).toContain(
			ImageLifecycleEventType.UploadCompleted,
		);
		expect(getEmittedMessage(IMAGE_TELEMETRY_TOPIC).key).toContain(
			ImageTelemetryEventType.UploadCompleted,
		);
		expect(imageManager.deleteMainImage).toHaveBeenCalledWith({
			path: 'products/image',
			name: 'previous.png',
		});
		expect(imageManager.deleteTempImage).toHaveBeenCalledWith(file.filename);
	});

	it('파일 업로드 후 file.image.events.v1 텔레메트리 이벤트를 정확한 계약으로 발행한다', async () => {
		const file = createMulterFile();

		const result = await service.uploadFile({
			file,
			apiInfo: {
				externalImageId: 10,
				path: 'products/image',
			},
			clientServiceContext,
		});

		const telemetryMessage = getEmittedMessage(IMAGE_TELEMETRY_TOPIC);
		const telemetryPayload = parseKafkaPayload(telemetryMessage);

		expect(telemetryMessage.key).toBe(
			`${result.imageKey}:${ImageTelemetryEventType.UploadCompleted}`,
		);
		expect(telemetryPayload).toEqual(
			expect.objectContaining({
				schemaVersion: 1,
				eventType: ImageTelemetryEventType.UploadCompleted,
				sourceApp: 'storage',
				environment: 'test',
				imageId: 10,
				path: 'products/image',
				name: result.name,
				originalName: 'sample.png',
				imageKey: result.imageKey,
				format: 'png',
				inputBytes: file.size,
				outputBytes: 128,
				status: 'success',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: 'req-storage-1',
				traceId: 'trace-storage-1',
			}),
		);
		expect(telemetryPayload.eventId).toEqual(expect.any(String));
		expect(telemetryPayload.occurredAt).toEqual(expect.any(String));
		expect(telemetryPayload.durationMs).toEqual(expect.any(Number));
		expect(imagePregenerationService.preGenerateForUpload).toHaveBeenCalledWith(
			{
				clientServiceId: 'service-1',
				path: 'products/image',
				name: result.name,
			},
		);
		expect(result).toEqual(
			expect.objectContaining({
				imageKey: `products/image/${result.name}`,
				path: 'products/image',
				originalName: 'sample.png',
				format: 'png',
				size: 128,
				eventId: telemetryPayload.eventId,
			}),
		);
	});

	it('PRE_GENERATE 정책 결과를 resize 완료/실패 텔레메트리로 발행한다', async () => {
		const file = createMulterFile();
		const results: ImagePregenerationResult[] = [
			{
				variantId: 'variant-webp',
				width: 400,
				height: 400,
				format: 'webp',
				variantName: 'sample__w400_h400.webp',
				inputBytes: 128,
				outputBytes: 42,
				durationMs: 7,
				status: 'success',
			},
			{
				variantId: 'variant-failed',
				width: 800,
				format: 'jpeg',
				durationMs: 3,
				status: 'failed',
				error: new Error('sharp failed'),
			},
		];
		imagePregenerationService.preGenerateForUpload.mockResolvedValue(results);

		const result = await service.uploadFile({
			file,
			apiInfo: {
				externalImageId: 10,
				path: 'products/image',
			},
			clientServiceContext,
		});

		const telemetryPayloads = getEmittedMessages(IMAGE_TELEMETRY_TOPIC).map(
			parseKafkaPayload,
		);
		expect(telemetryPayloads).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: ImageTelemetryEventType.ResizeCompleted,
					sourceApp: 'resize',
					imageId: 10,
					path: 'products/image',
					name: result.name,
					imageKey: result.imageKey,
					cacheKey: `${result.imageKey}:400x400:webp`,
					width: 400,
					height: 400,
					format: 'webp',
					inputBytes: 128,
					outputBytes: 42,
					durationMs: 7,
					status: 'success',
					clientServiceId: 'service-1',
					clientServiceSlug: 'local-demo',
				}),
				expect.objectContaining({
					eventType: ImageTelemetryEventType.ResizeFailed,
					sourceApp: 'resize',
					imageId: 10,
					path: 'products/image',
					name: result.name,
					imageKey: result.imageKey,
					cacheKey: `${result.imageKey}:800xauto:jpeg`,
					width: 800,
					format: 'jpeg',
					status: 'failed',
					errorCode: 'Error',
					errorMessage: 'sharp failed',
				}),
			]),
		);
	});

	it('파일 업로드 후 file.image.lifecycle.v1 lifecycle 이벤트를 발행한다', async () => {
		const file = createMulterFile();

		const result = await service.uploadFile({
			file,
			apiInfo: {
				externalImageId: 10,
				path: 'products/image',
			},
			clientServiceContext,
		});

		const lifecycleMessage = getEmittedMessage(IMAGE_LIFECYCLE_TOPIC);
		const lifecyclePayload = parseKafkaPayload(lifecycleMessage);

		expect(lifecycleMessage.key).toBe(
			`local-demo:${result.imageKey}:${ImageLifecycleEventType.UploadCompleted}`,
		);
		expect(lifecyclePayload).toEqual(
			expect.objectContaining({
				schemaVersion: 1,
				eventType: ImageLifecycleEventType.UploadCompleted,
				sourceApp: 'storage',
				environment: 'test',
				imageId: 10,
				path: 'products/image',
				name: result.name,
				originalName: 'sample.png',
				imageKey: result.imageKey,
				format: 'png',
				inputBytes: file.size,
				outputBytes: 128,
				status: 'success',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: 'req-storage-1',
				traceId: 'trace-storage-1',
			}),
		);
		expect(lifecyclePayload.eventId).toEqual(expect.any(String));
		expect(lifecyclePayload.occurredAt).toEqual(expect.any(String));
		expect(lifecyclePayload.durationMs).toEqual(expect.any(Number));
	});

	it('업로드 실패 시 실패 텔레메트리 이벤트를 발행하고 임시 파일을 정리한다', async () => {
		const file = createMulterFile();
		imageManager.saveImageFromTemp.mockRejectedValue(new Error('disk down'));

		await expect(
			service.uploadFile({
				file,
				apiInfo: {
					externalImageId: 10,
					path: 'products/image',
				},
			}),
		).rejects.toThrow('disk down');

		const telemetryPayload = parseKafkaPayload(
			getEmittedMessage(IMAGE_TELEMETRY_TOPIC),
		);
		const lifecyclePayload = parseKafkaPayload(
			getEmittedMessage(IMAGE_LIFECYCLE_TOPIC),
		);
		expect(lifecyclePayload).toEqual(
			expect.objectContaining({
				eventType: ImageLifecycleEventType.UploadFailed,
				sourceApp: 'storage',
				imageId: 10,
				path: 'products/image',
				name: 'sample.png',
				originalName: 'sample.png',
				imageKey: 'products/image/sample.png',
				status: 'failed',
				errorCode: 'Error',
				errorMessage: 'disk down',
			}),
		);
		expect(telemetryPayload).toEqual(
			expect.objectContaining({
				eventType: ImageTelemetryEventType.UploadFailed,
				sourceApp: 'storage',
				imageId: 10,
				path: 'products/image',
				name: 'sample.png',
				originalName: 'sample.png',
				imageKey: 'products/image/sample.png',
				status: 'failed',
				errorCode: 'Error',
				errorMessage: 'disk down',
			}),
		);
		expect(imageManager.deleteTempImage).toHaveBeenCalledWith(file.filename);
	});

	it('저장 후 telemetry Kafka 발행이 실패해도 업로드와 임시 파일 정리를 유지한다', async () => {
		const file = createMulterFile();
		const warnSpy = jest.spyOn(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(service as any).logger,
			'warn',
		);
		imageClient.emit.mockImplementation((topic) => {
			if (topic === IMAGE_TELEMETRY_TOPIC) {
				return throwError(() => new Error('kafka down'));
			}
			return of({ ok: true });
		});

		await expect(
			service.uploadFile({
				file,
				apiInfo: {
					externalImageId: 10,
					path: 'products/image',
				},
			}),
		).resolves.toEqual(
			expect.objectContaining({
				imageKey: expect.stringMatching(
					/^products\/image\/sample\.[0-9a-f-]{36}\.png$/,
				),
				originalName: 'sample.png',
				eventId: expect.any(String),
			}),
		);

		expect(imageManager.deleteTempImage).toHaveBeenCalledWith(file.filename);
		expect(imageManager.deleteMainImage).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalled();
	});

	it('메인 이미지 디렉터리 규칙에 맞춰 이미지 버퍼를 가져온다', async () => {
		const image = Buffer.from('stored-image');
		imageManager.getBufferImage.mockResolvedValue({
			image,
			name: 'sample.png',
		});

		const result = await service.getImage({
			path: 'products',
			name: 'sample.png',
		});

		expect(imageManager.getBufferImage).toHaveBeenCalledWith({
			path: 'products/image',
			name: 'sample.png',
		});
		expect(result.image).toBe(image);
	});

	it('PRE_GENERATE variant가 있으면 원본 대신 variant 버퍼를 반환한다', async () => {
		const variantImage = Buffer.from('variant-image');
		imagePregenerationService.findPreGeneratedVariantForRequest.mockResolvedValue(
			{
				image: variantImage,
				name: 'sample__w400_h400.webp',
				width: 400,
				height: 400,
				format: 'webp',
			},
		);

		const result = await service.getImage(
			{
				path: 'products',
				name: 'sample.png',
				width: 400,
				height: 400,
				format: 'webp',
			},
			clientServiceContext,
		);

		expect(
			imagePregenerationService.findPreGeneratedVariantForRequest,
		).toHaveBeenCalledWith({
			clientServiceId: 'service-1',
			path: 'products/image',
			name: 'sample.png',
			width: 400,
			height: 400,
			format: 'webp',
		});
		expect(imageManager.getBufferImage).not.toHaveBeenCalled();
		expect(result).toEqual(
			expect.objectContaining({
				image: variantImage,
				name: 'sample__w400_h400.webp',
				width: 400,
				height: 400,
				format: 'webp',
				preGeneratedVariant: {
					width: 400,
					height: 400,
					format: 'webp',
				},
			}),
		);
	});

	it('메인 이미지 삭제 후 cache 앱의 리사이즈 캐시를 무효화한다', async () => {
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
			lifecycleOutbox as unknown as ImageLifecycleOutboxService,
			imagePregenerationService as unknown as ImagePregenerationService,
			{
				CACHE_SERVER: 'http://cache.test',
			} as AppConfig,
		);

		await service.deleteImage({
			path: 'products/image',
			name: 'sample.png',
			clientServiceContext,
		});

		expect(imageManager.deleteMainImage).toHaveBeenCalledWith({
			path: 'products/image',
			name: 'sample.png',
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			'http://cache.test/image/products/sample.png/cache',
			{
				method: 'DELETE',
				headers: {
					'x-client-api-key': 'fs_prefix_secret',
					'x-request-id': 'req-storage-1',
					'x-trace-id': 'trace-storage-1',
				},
			},
		);
	});
});
