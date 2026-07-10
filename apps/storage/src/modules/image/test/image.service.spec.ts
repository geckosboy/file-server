import { ClientKafka } from '@nestjs/microservices';
import {
	ClientServiceAuthContext,
	INTERNAL_API_KEY_HEADER,
	INTERNAL_CLIENT_CONTEXT_HEADER,
	INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER,
} from '@file/database';
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
import { ImageAssetLifecycleService } from '../image-asset-lifecycle.service';
import { ImageCacheInvalidationPublisher } from '../image-cache-invalidation.publisher';
import { ImageLifecycleMetricsService } from '../image-lifecycle-metrics.service';

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
};

const originalMetadataWritesFlag =
	process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED;
const originalDualReadFlag = process.env.IMAGE_ASSET_DUAL_READ_ENABLED;
const originalSyncPregenerationFlag =
	process.env.IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED;

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
			| 'preGenerateForUpload'
			| 'findPreGeneratedVariantForRequest'
			| 'assertSourceReadable'
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
			assertSourceReadable: jest.fn().mockResolvedValue(null),
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
		if (originalMetadataWritesFlag === undefined) {
			delete process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED;
		} else {
			process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED =
				originalMetadataWritesFlag;
		}
		if (originalSyncPregenerationFlag === undefined) {
			delete process.env.IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED;
		} else {
			process.env.IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED =
				originalSyncPregenerationFlag;
		}
		if (originalDualReadFlag === undefined) {
			delete process.env.IMAGE_ASSET_DUAL_READ_ENABLED;
		} else {
			process.env.IMAGE_ASSET_DUAL_READ_ENABLED = originalDualReadFlag;
		}
		jest.restoreAllMocks();
	});

	it('Authoritative lifecycle flag는 authoritative lifecycle을 사용하고 legacy 응답 필드에 asset 상태를 추가한다', async () => {
		process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED = 'true';
		process.env.IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED = 'false';
		const lifecycle = {
			upload: jest.fn().mockResolvedValue({
				assetId: 'asset-1',
				eventId: 'upload-event-1',
				variantStatus: 'Pending',
				path: 'products/image',
				name: 'sample.stable.png',
				storageKey: 'products/image/sample.stable.png',
				checksum: 'source-checksum',
				size: 80,
				format: 'png',
				durationMs: 5,
			}),
		};
		const invalidation = { publish: jest.fn().mockResolvedValue(true) };
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
			lifecycleOutbox as unknown as ImageLifecycleOutboxService,
			imagePregenerationService as unknown as ImagePregenerationService,
			undefined,
			lifecycle as unknown as ImageAssetLifecycleService,
			invalidation as unknown as ImageCacheInvalidationPublisher,
		);

		const result = await service.uploadFile({
			file: createMulterFile(),
			apiInfo: { path: 'products/image', externalImageId: 10 },
			clientServiceContext,
			idempotencyKey: 'image-upload:v1:stable',
		});

		expect(lifecycle.upload).toHaveBeenCalledWith(
			expect.any(PngStrategy),
			expect.objectContaining({
				idempotencyKey: 'image-upload:v1:stable',
				clientServiceId: 'service-1',
				path: 'products/image',
				inputBytes: 11,
			}),
		);
		expect(imageManager.saveImageFromTemp).not.toHaveBeenCalled();
		expect(
			imagePregenerationService.preGenerateForUpload,
		).not.toHaveBeenCalled();
		const storedName = (lifecycle.upload.mock.calls[0][1] as { name: string })
			.name;
		expect(result).toEqual({
			imageKey: `products/image/${storedName}`,
			path: 'products/image',
			name: storedName,
			originalName: 'sample.png',
			format: 'png',
			size: 80,
			eventId: 'upload-event-1',
			assetId: 'asset-1',
			variantStatus: 'Pending',
		});
	});

	it('Authoritative lifecycle flag off는 기존 저장/동기 pregeneration/응답 계약을 유지한다', async () => {
		process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED = 'false';
		const lifecycle = { upload: jest.fn() };
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
			lifecycleOutbox as unknown as ImageLifecycleOutboxService,
			imagePregenerationService as unknown as ImagePregenerationService,
			undefined,
			lifecycle as unknown as ImageAssetLifecycleService,
		);

		const result = await service.uploadFile({
			file: createMulterFile(),
			apiInfo: { path: 'products/image', externalImageId: 10 },
			clientServiceContext,
			idempotencyKey: 'image-upload:v1:stable',
		});

		expect(lifecycle.upload).not.toHaveBeenCalled();
		expect(imageManager.saveImageFromTemp).toHaveBeenCalled();
		expect(imagePregenerationService.preGenerateForUpload).toHaveBeenCalled();
		expect(result).toEqual(
			expect.objectContaining({
				imageKey: expect.any(String),
				path: 'products/image',
				name: expect.any(String),
				originalName: 'sample.png',
				format: 'png',
				size: 128,
				eventId: expect.any(String),
			}),
		);
		expect(result).not.toHaveProperty('assetId');
		expect(result).not.toHaveProperty('variantStatus');
	});

	it('Authoritative lifecycle sync compatibility는 asset identity를 전달하고 응답 variantStatus를 Ready로 수렴한다', async () => {
		process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED = 'true';
		process.env.IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED = 'true';
		const lifecycle = {
			upload: jest.fn().mockResolvedValue({
				assetId: 'asset-1',
				eventId: 'upload-event-1',
				variantStatus: 'Pending',
				path: 'products/image',
				name: 'sample.stable.png',
				storageKey: 'products/image/sample.stable.png',
				checksum: 'source-checksum',
				size: 80,
				format: 'png',
				durationMs: 5,
			}),
		};
		imagePregenerationService.preGenerateForUpload.mockResolvedValue([
			{
				variantId: 'variant-1',
				width: 400,
				format: 'webp',
				durationMs: 5,
				status: 'success',
			},
		]);
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
			lifecycleOutbox as unknown as ImageLifecycleOutboxService,
			imagePregenerationService as unknown as ImagePregenerationService,
			undefined,
			lifecycle as unknown as ImageAssetLifecycleService,
		);

		const result = await service.uploadFile({
			file: createMulterFile(),
			apiInfo: { path: 'products/image', externalImageId: 10 },
			clientServiceContext,
			idempotencyKey: 'image-upload:v1:stable',
		});

		expect(imagePregenerationService.preGenerateForUpload).toHaveBeenCalledWith(
			expect.objectContaining({
				clientServiceId: 'service-1',
				assetId: 'asset-1',
				sourceChecksum: 'source-checksum',
				path: 'products/image',
			}),
		);
		expect(result).toEqual(
			expect.objectContaining({ assetId: 'asset-1', variantStatus: 'Ready' }),
		);
	});

	it('Authoritative lifecycle upload 실패는 legacy Kafka publish를 기다리지 않고 원래 오류를 보존한다', async () => {
		process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED = 'true';
		const lifecycle = {
			upload: jest.fn().mockRejectedValue(new Error('disk down')),
		};
		lifecycleOutbox.enqueueAndPublish.mockReturnValue(
			new Promise<void>(() => undefined),
		);
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
			lifecycleOutbox as unknown as ImageLifecycleOutboxService,
			imagePregenerationService as unknown as ImagePregenerationService,
			undefined,
			lifecycle as unknown as ImageAssetLifecycleService,
		);

		await expect(
			Promise.race([
				service.uploadFile({
					file: createMulterFile(),
					apiInfo: { path: 'products/image', externalImageId: 10 },
					clientServiceContext,
					idempotencyKey: 'image-upload:v1:stable',
				}),
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error('request awaited Kafka')), 100),
				),
			]),
		).rejects.toThrow('disk down');
		expect(lifecycleOutbox.enqueueAndPublish).not.toHaveBeenCalled();
		expect(imageManager.deleteTempImage).toHaveBeenCalledWith('temp-file.png');
	});

	it('Authoritative lifecycle delete는 authoritative eventId로 완료 telemetry를 발행한다', async () => {
		process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED = 'true';
		const lifecycle = {
			delete: jest.fn().mockResolvedValue({
				alreadyDeleted: false,
				eventId: 'delete-event-1',
			}),
		};
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
			lifecycleOutbox as unknown as ImageLifecycleOutboxService,
			imagePregenerationService as unknown as ImagePregenerationService,
			undefined,
			lifecycle as unknown as ImageAssetLifecycleService,
		);

		await service.deleteImage({
			path: 'products/image',
			name: 'sample.png',
			clientServiceContext,
		});

		expect(lifecycle.delete).toHaveBeenCalledWith({
			clientServiceId: 'service-1',
			path: 'products/image',
			name: 'sample.png',
		});
		expect(imageManager.deleteMainImage).not.toHaveBeenCalled();
		expect(parseKafkaPayload(getEmittedMessage(IMAGE_TELEMETRY_TOPIC))).toEqual(
			expect.objectContaining({
				eventId: 'delete-event-1',
				eventType: ImageTelemetryEventType.DeleteCompleted,
				status: 'success',
			}),
		);
	});

	it('dual-read 중 authoritative metadata가 없으면 legacy filesystem delete로 fallback한다', async () => {
		process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED = 'true';
		process.env.IMAGE_ASSET_DUAL_READ_ENABLED = 'true';
		const lifecycle = {
			delete: jest.fn().mockResolvedValue({
				alreadyDeleted: true,
				metadataMissing: true,
			}),
		};
		const cacheInvalidationPublisher = {
			publish: jest.fn().mockResolvedValue(true),
		};
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
			lifecycleOutbox as unknown as ImageLifecycleOutboxService,
			imagePregenerationService as unknown as ImagePregenerationService,
			{
				CACHE_SERVER: 'http://cache.test',
				INTERNAL_API_KEY: 'internal-test-key',
			} as AppConfig,
			lifecycle as unknown as ImageAssetLifecycleService,
			cacheInvalidationPublisher as unknown as ImageCacheInvalidationPublisher,
			new ImageLifecycleMetricsService(),
		);

		await service.deleteImage({
			path: 'products/image',
			name: 'legacy.png',
			clientServiceContext,
		});

		expect(imageManager.deleteMainImage).toHaveBeenCalledWith({
			path: 'products/image',
			name: 'legacy.png',
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			'http://cache.test/image/products/legacy.png/cache',
			expect.objectContaining({ method: 'DELETE' }),
		);
		expect(cacheInvalidationPublisher.publish).toHaveBeenCalledWith({
			eventId: expect.any(String),
			clientServiceId: 'service-1',
			path: 'products',
			name: 'legacy.png',
			reason: 'delete',
		});
	});

	it('authoritative Deleted metadata는 dual-read 중에도 legacy file을 재삭제하지 않는다', async () => {
		process.env.IMAGE_ASSET_METADATA_WRITES_ENABLED = 'true';
		process.env.IMAGE_ASSET_DUAL_READ_ENABLED = 'true';
		const lifecycle = {
			delete: jest.fn().mockResolvedValue({ alreadyDeleted: true }),
		};
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
			lifecycleOutbox as unknown as ImageLifecycleOutboxService,
			imagePregenerationService as unknown as ImagePregenerationService,
			undefined,
			lifecycle as unknown as ImageAssetLifecycleService,
		);

		await service.deleteImage({
			path: 'products/image',
			name: 'deleted.png',
			clientServiceContext,
		});

		expect(imageManager.deleteMainImage).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
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

	it('긴 원본명도 suffix와 확장자를 보존하며 API filename 상한에 맞춘다', () => {
		const storedName = createStoredImageName(
			`${'a'.repeat(120)}.png`,
			'1'.repeat(32),
			127,
		);

		expect(storedName).toHaveLength(127);
		expect(storedName).toMatch(/\.1{32}\.png$/);
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
			authoritativeAsset: undefined,
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

	it('authoritative tombstone 또는 준비 중 상태면 filesystem을 읽지 않는다', async () => {
		imagePregenerationService.assertSourceReadable.mockRejectedValue(
			new Error('authoritative asset is not Ready'),
		);

		await expect(
			service.getImage(
				{ path: 'products', name: 'sample.png' },
				clientServiceContext,
			),
		).rejects.toThrow('authoritative asset is not Ready');
		expect(imageManager.getBufferImage).not.toHaveBeenCalled();
		expect(
			imagePregenerationService.findPreGeneratedVariantForRequest,
		).not.toHaveBeenCalled();
	});

	it('메인 이미지 삭제 후 cache 앱의 리사이즈 캐시를 무효화한다', async () => {
		const cacheInvalidationPublisher = {
			publish: jest.fn().mockResolvedValue(true),
		};
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
			lifecycleOutbox as unknown as ImageLifecycleOutboxService,
			imagePregenerationService as unknown as ImagePregenerationService,
			{
				CACHE_SERVER: 'http://cache.test',
				INTERNAL_API_KEY: 'internal-test-key',
			} as AppConfig,
			undefined,
			cacheInvalidationPublisher as unknown as ImageCacheInvalidationPublisher,
			new ImageLifecycleMetricsService(),
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
				headers: expect.objectContaining({
					[INTERNAL_API_KEY_HEADER]: 'internal-test-key',
					[INTERNAL_CLIENT_CONTEXT_HEADER]: expect.any(String),
					[INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER]: expect.any(String),
				}),
			},
		);
		expect(cacheInvalidationPublisher.publish).toHaveBeenCalledWith({
			eventId: expect.any(String),
			clientServiceId: 'service-1',
			path: 'products',
			name: 'sample.png',
			reason: 'delete',
		});
	});
});
