import {
	ForbiddenException,
	INestApplication,
	ValidationPipe,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import {
	ClientServiceApiKeyGuard,
	ClientServiceAuthContext,
	ClientServiceAuthService,
	ClientServiceAuthorizationService,
	InternalServiceGuard,
	createInternalServiceForwardHeaders,
} from '@file/database';
import { readdir, rm } from 'fs/promises';
import * as path from 'path';
import { of } from 'rxjs';
import request, { type Test as SuperTestRequest } from 'supertest';
import sharp from 'sharp';
import { Root } from '../src/enum';
import { AppController } from '../src/app.controller';
import { ImageController } from '../src/modules/image/image.controller';
import { ImageService } from '../src/modules/image/image.service';
import { PolicyAwareImageUploadInterceptor } from '../src/modules/image/policy-aware-image-upload.interceptor';
import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEventType,
} from '../src/modules/image/image.telemetry';
import {
	createLifecycleKafkaKey,
	IMAGE_LIFECYCLE_TOPIC,
	ImageLifecycleEvent,
	ImageLifecycleEventType,
} from '../src/modules/image/image.lifecycle';
import { ImageLifecycleOutboxService } from '../src/modules/image/image-lifecycle-outbox.service';
import { ImagePregenerationService } from '../src/modules/image/image-pregeneration.service';
import { ImageManager } from '../src/modules/image/strategies/manager';
import { JpegStrategy } from '../src/modules/image/strategies/sharp/jpeg.strategy';
import { PngStrategy } from '../src/modules/image/strategies/sharp/png.strategy';

const testClientApiKey = 'fs_prefix_secret';
const testRequestId = 'req-storage-e2e';
const testInternalApiKey = 'internal-test-key';
const assetRoot = path.resolve(Root, 'assets', 'e2e-storage');
const tempRoot = path.resolve(Root, 'temp');

const clientServiceContext: ClientServiceAuthContext = {
	clientServiceId: 'service-1',
	clientServiceSlug: 'local-demo',
	clientServiceName: 'Local Demo',
	clientServiceKeyId: 'key-1',
	keyPrefix: 'prefix-1',
	requestId: testRequestId,
};

type KafkaEmitPayload = { key: string; value: string };

const parseKafkaPayload = (payload: KafkaEmitPayload) =>
	JSON.parse(payload.value) as Record<string, unknown>;

const createPngImage = () =>
	sharp({
		create: {
			width: 8,
			height: 6,
			channels: 3,
			background: '#abcdef',
		},
	})
		.png()
		.toBuffer();

const createAuthService = () => ({
	authenticate: jest.fn((apiKey: string) =>
		Promise.resolve(
			apiKey === testClientApiKey
				? {
						clientService: {
							id: 'service-1',
							slug: 'local-demo',
							name: 'Local Demo',
							status: 'ACTIVE',
						},
						key: {
							id: 'key-1',
							keyPrefix: 'prefix-1',
						},
					}
				: null,
		),
	),
});

const authorized = (agent: SuperTestRequest) =>
	agent
		.set('x-client-api-key', testClientApiKey)
		.set('x-request-id', testRequestId);

const internalAuthorized = (agent: SuperTestRequest) => {
	const headers = createInternalServiceForwardHeaders(
		clientServiceContext,
		testInternalApiKey,
		{ audience: 'storage', action: 'image.read' },
	);
	return Object.entries(headers).reduce(
		(req, [name, value]) => req.set(name, value),
		agent,
	);
};

describe('스토리지 앱 e2e', () => {
	const originalInternalApiKey = process.env.INTERNAL_API_KEY;
	let app: INestApplication;
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
	let authService: ReturnType<typeof createAuthService>;
	let authorization: { authorize: jest.Mock };

	const getTelemetryPayloads = () =>
		imageClient.emit.mock.calls
			.filter(([topic]) => topic === IMAGE_TELEMETRY_TOPIC)
			.map(([, payload]) => parseKafkaPayload(payload as KafkaEmitPayload));

	const getLifecyclePayloads = () =>
		imageClient.emit.mock.calls
			.filter(([topic]) => topic === IMAGE_LIFECYCLE_TOPIC)
			.map(([, payload]) => parseKafkaPayload(payload as KafkaEmitPayload));

	beforeEach(async () => {
		process.env.INTERNAL_API_KEY = testInternalApiKey;
		await rm(assetRoot, { recursive: true, force: true });
		await rm(tempRoot, { recursive: true, force: true });

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
		authService = createAuthService();
		authorization = {
			authorize: jest.fn().mockResolvedValue({ allowed: true }),
		};

		const moduleFixture: TestingModule = await Test.createTestingModule({
			controllers: [AppController, ImageController],
			providers: [
				ImageService,
				PolicyAwareImageUploadInterceptor,
				ClientServiceApiKeyGuard,
				InternalServiceGuard,
				{
					provide: ClientServiceAuthService,
					useValue: authService,
				},
				{
					provide: ClientServiceAuthorizationService,
					useValue: authorization,
				},
				PngStrategy,
				JpegStrategy,
				ImageManager,
				{
					provide: 'IMAGE_MICROSERVICE',
					useValue: imageClient,
				},
				{
					provide: ImageLifecycleOutboxService,
					useValue: lifecycleOutbox,
				},
				{
					provide: ImagePregenerationService,
					useValue: imagePregenerationService,
				},
			],
		}).compile();

		app = moduleFixture.createNestApplication();
		app.useGlobalPipes(
			new ValidationPipe({
				whitelist: true,
				transform: true,
			}),
		);
		await app.init();
	});

	afterEach(async () => {
		await app.close();
		if (originalInternalApiKey === undefined) {
			delete process.env.INTERNAL_API_KEY;
		} else {
			process.env.INTERNAL_API_KEY = originalInternalApiKey;
		}
		await rm(assetRoot, { recursive: true, force: true });
		await rm(tempRoot, { recursive: true, force: true });
	});

	it('상태 확인 요청에 정상 응답을 반환한다', () => {
		return request(app.getHttpServer())
			.get('/health-check')
			.expect(200)
			.expect('OK');
	});

	it('클라이언트 서비스 API 키가 없으면 이미지 업로드를 거부한다', async () => {
		const image = await createPngImage();

		await request(app.getHttpServer())
			.post('/image')
			.field('path', 'e2e-storage/image')
			.attach('file', image, {
				filename: 'sample.png',
				contentType: 'image/png',
			})
			.expect(401);
	});

	it('클라이언트 서비스 API 키만으로는 이미지 조회를 거부한다', async () => {
		await authorized(
			request(app.getHttpServer()).get('/image/e2e-storage/sample.png'),
		).expect(401);
	});

	it('정책 maxUploadBytes를 넘으면 413이고 임시 파일을 남기지 않는다', async () => {
		const image = await createPngImage();
		authorization.authorize.mockResolvedValue({
			allowed: true,
			maxUploadBytes: image.byteLength - 1,
		});

		await authorized(request(app.getHttpServer()).post('/image'))
			.field('path', 'e2e-storage/image')
			.attach('file', image, {
				filename: 'too-large.png',
				contentType: 'image/png',
			})
			.expect(413);

		await expect(readdir(tempRoot)).resolves.toEqual([]);
	});

	it('beforeName 교체는 delete 권한이 없으면 403이고 임시 파일을 제거한다', async () => {
		const image = await createPngImage();
		authorization.authorize
			.mockResolvedValueOnce({ allowed: true })
			.mockRejectedValueOnce(new ForbiddenException());

		await authorized(request(app.getHttpServer()).post('/image'))
			.field('path', 'e2e-storage/image')
			.field('beforeName', 'previous.png')
			.attach('file', image, {
				filename: 'replacement.png',
				contentType: 'image/png',
			})
			.expect(403);

		await expect(readdir(tempRoot)).resolves.toEqual([]);
	});

	it('업로드 이미지를 path/image/name 규칙으로 저장하고 조회와 삭제를 수행한다', async () => {
		const image = await createPngImage();

		const uploadResponse = await authorized(
			request(app.getHttpServer()).post('/image'),
		)
			.field('externalImageId', '100')
			.field('path', 'e2e-storage/image')
			.attach('file', image, {
				filename: 'sample.png',
				contentType: 'image/png',
			})
			.expect(201)
			.expect(({ body }) => {
				expect(body).toMatchObject({
					path: 'e2e-storage/image',
					originalName: 'sample.png',
					format: 'png',
					size: expect.any(Number),
					eventId: expect.any(String),
				});
				expect(body.name).toMatch(/^sample\.[0-9a-f-]{36}\.png$/);
				expect(body.imageKey).toBe(`e2e-storage/image/${body.name}`);
			});
		const uploaded = uploadResponse.body as {
			imageKey: string;
			name: string;
		};

		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.UploadCompleted,
				sourceApp: 'storage',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: testRequestId,
				imageId: 100,
				path: 'e2e-storage/image',
				name: uploaded.name,
				originalName: 'sample.png',
				imageKey: uploaded.imageKey,
				status: 'success',
			}),
		]);
		expect(getLifecyclePayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageLifecycleEventType.UploadCompleted,
				sourceApp: 'storage',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: testRequestId,
				imageId: 100,
				path: 'e2e-storage/image',
				name: uploaded.name,
				originalName: 'sample.png',
				imageKey: uploaded.imageKey,
				status: 'success',
			}),
		]);

		const getResponse = await internalAuthorized(
			request(app.getHttpServer()).get(`/image/e2e-storage/${uploaded.name}`),
		)
			.expect(200)
			.expect('content-type', /image\/png/);
		const metadata = await sharp(Buffer.from(getResponse.body)).metadata();
		expect(metadata.format).toBe('png');
		expect(metadata.width).toBe(8);
		expect(metadata.height).toBe(6);

		await authorized(request(app.getHttpServer()).delete('/image'))
			.query({
				imageKey: uploaded.imageKey,
			})
			.expect(200);

		await internalAuthorized(
			request(app.getHttpServer()).get(`/image/e2e-storage/${uploaded.name}`),
		).expect(404);
	});

	it('PRE_GENERATE variant 요청은 사전 생성 파일을 우선 반환한다', async () => {
		const variant = await sharp({
			create: {
				width: 4,
				height: 4,
				channels: 3,
				background: '#00ff00',
			},
		})
			.webp()
			.toBuffer();
		imagePregenerationService.findPreGeneratedVariantForRequest.mockResolvedValue(
			{
				image: variant,
				name: 'sample__w4_h4.webp',
				width: 4,
				height: 4,
				format: 'webp',
			},
		);

		const response = await internalAuthorized(
			request(app.getHttpServer()).get('/image/e2e-storage/sample.png'),
		)
			.query({ width: 4, height: 4, format: 'webp' })
			.expect(200)
			.expect('x-file-server-pregenerated-variant', 'true')
			.expect('content-type', /image\/webp/);

		expect(Buffer.from(response.body).equals(variant)).toBe(true);
		expect(
			imagePregenerationService.findPreGeneratedVariantForRequest,
		).toHaveBeenCalledWith({
			clientServiceId: 'service-1',
			path: 'e2e-storage/image',
			name: 'sample.png',
			width: 4,
			height: 4,
			format: 'webp',
		});
	});

	it('업로드 시 beforeName이 있으면 이전 이미지를 삭제한다', async () => {
		const previousImage = await createPngImage();
		const nextImage = await createPngImage();

		const previousUpload = await authorized(
			request(app.getHttpServer()).post('/image'),
		)
			.field('externalImageId', '200')
			.field('path', 'e2e-storage/image')
			.attach('file', previousImage, {
				filename: 'previous.png',
				contentType: 'image/png',
			})
			.expect(201);
		const previous = previousUpload.body as { name: string };

		const nextUpload = await authorized(
			request(app.getHttpServer()).post('/image'),
		)
			.field('externalImageId', '201')
			.field('path', 'e2e-storage/image')
			.field('beforeName', previous.name)
			.attach('file', nextImage, {
				filename: 'next.png',
				contentType: 'image/png',
			})
			.expect(201);
		const next = nextUpload.body as { name: string };

		await internalAuthorized(
			request(app.getHttpServer()).get(`/image/e2e-storage/${previous.name}`),
		).expect(404);
		await internalAuthorized(
			request(app.getHttpServer()).get(`/image/e2e-storage/${next.name}`),
		).expect(200);
	});
});
