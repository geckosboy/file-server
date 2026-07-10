jest.mock('src/config', () => ({
	envConfig: {
		STORAGE_SERVER: 'http://storage.test',
		INTERNAL_API_KEY: 'internal-test-key',
	},
}));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import {
	ClientServiceAuthContext,
	ClientServiceAuthorizationService,
	INTERNAL_API_KEY_HEADER,
	INTERNAL_CLIENT_CONTEXT_HEADER,
	INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER,
	InternalServiceGuard,
	createInternalServiceForwardHeaders,
} from '@file/database';
import { of } from 'rxjs';
import request, { type Test as SuperTestRequest } from 'supertest';
import sharp from 'sharp';
import { AppController } from '../src/app.controller';
import { ImageController } from '../src/modules/image/image.controller';
import { ImageManager } from '../src/modules/image/manager';
import { ImageService } from '../src/modules/image/image.service';
import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEventType,
} from '../src/modules/image/image.telemetry';

const testInternalApiKey = 'internal-test-key';
const testRequestId = 'req-resize-e2e';
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

const createFetchResponse = (
	body: Buffer,
	options: { status?: number; headers?: HeadersInit } = {},
) =>
	new Response(new Uint8Array(body), {
		status: options.status ?? 200,
		headers: options.headers,
	});

const internalAuthorized = (agent: SuperTestRequest) => {
	const headers = createInternalServiceForwardHeaders(
		clientServiceContext,
		testInternalApiKey,
		{ audience: 'resize', action: 'image.read' },
	);
	return Object.entries(headers).reduce(
		(req, [name, value]) => req.set(name, value),
		agent,
	);
};

describe('리사이즈 앱 e2e', () => {
	const originalInternalApiKey = process.env.INTERNAL_API_KEY;
	let app: INestApplication;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;
	let imageClient: jest.Mocked<Pick<ClientKafka, 'emit'>>;
	let originalImage: Buffer;
	let authorization: { authorize: jest.Mock };

	const getTelemetryPayloads = () =>
		imageClient.emit.mock.calls
			.filter(([topic]) => topic === IMAGE_TELEMETRY_TOPIC)
			.map(([, payload]) => parseKafkaPayload(payload as KafkaEmitPayload));

	beforeEach(async () => {
		process.env.INTERNAL_API_KEY = testInternalApiKey;
		originalImage = await sharp({
			create: {
				width: 24,
				height: 12,
				channels: 3,
				background: '#336699',
			},
		})
			.png()
			.toBuffer();

		fetchSpy = jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(createFetchResponse(originalImage));
		imageClient = {
			emit: jest.fn().mockReturnValue(of({ ok: true })),
		};
		authorization = {
			authorize: jest.fn().mockResolvedValue({ allowed: true }),
		};

		const moduleFixture: TestingModule = await Test.createTestingModule({
			controllers: [AppController, ImageController],
			providers: [
				ImageService,
				InternalServiceGuard,
				{
					provide: ClientServiceAuthorizationService,
					useValue: authorization,
				},
				ImageManager,
				{
					provide: 'RESIZE_IMAGE_MICROSERVICE',
					useValue: imageClient,
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
		jest.restoreAllMocks();
	});

	it('상태 확인 요청에 정상 응답을 반환한다', () => {
		return request(app.getHttpServer())
			.get('/health-check')
			.expect(200)
			.expect('OK');
	});

	it('내부 API 키가 없으면 이미지 조회를 거부한다', () => {
		return request(app.getHttpServer())
			.get('/image/public/sample.png')
			.expect(401);
	});

	it('크기 쿼리가 없으면 스토리지 앱의 원본 이미지를 반환한다', async () => {
		const response = await internalAuthorized(
			request(app.getHttpServer()).get('/image/public/sample.png'),
		)
			.expect(200)
			.expect('content-type', /image\/png/);

		expect(Buffer.from(response.body).equals(originalImage)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith(
			'http://storage.test/image/public/sample.png',
			expect.any(Object),
		);
		const fetchOptions = fetchSpy.mock.calls[0][1] as RequestInit;
		expect(fetchOptions).toEqual({
			method: 'get',
			headers: expect.objectContaining({
				[INTERNAL_API_KEY_HEADER]: testInternalApiKey,
				[INTERNAL_CLIENT_CONTEXT_HEADER]: expect.any(String),
				[INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER]: expect.any(String),
			}),
		});
	});

	it('너비와 높이 쿼리가 있으면 리사이즈된 이미지를 반환한다', async () => {
		const response = await internalAuthorized(
			request(app.getHttpServer()).get('/image/public/sample.png'),
		)
			.query({ width: 6, height: 3 })
			.expect(200)
			.expect('content-type', /image\/png/);
		const metadata = await sharp(Buffer.from(response.body)).metadata();

		expect(metadata.width).toBe(6);
		expect(metadata.height).toBe(3);
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeRequested,
				path: 'public',
				name: 'sample.png',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: testRequestId,
				width: 6,
				height: 3,
				status: 'success',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeCompleted,
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: testRequestId,
				status: 'success',
			}),
		]);
	});

	it('스토리지의 pre-generated variant hit이면 리사이징 없이 반환한다', async () => {
		const variantImage = await sharp({
			create: {
				width: 6,
				height: 3,
				channels: 3,
				background: '#00aa55',
			},
		})
			.webp()
			.toBuffer();
		fetchSpy.mockResolvedValue(
			createFetchResponse(variantImage, {
				headers: {
					'content-type': 'image/webp',
					'x-file-server-pregenerated-variant': 'true',
				},
			}),
		);

		const response = await internalAuthorized(
			request(app.getHttpServer()).get('/image/public/sample.png'),
		)
			.query({ width: 6, height: 3, format: 'webp' })
			.expect(200)
			.expect('content-type', /image\/webp/);
		const metadata = await sharp(Buffer.from(response.body)).metadata();

		expect(metadata.format).toBe('webp');
		expect(metadata.width).toBe(6);
		expect(metadata.height).toBe(3);
		expect(fetchSpy).toHaveBeenCalledWith(
			'http://storage.test/image/public/sample.png?width=6&height=3&format=webp',
			expect.any(Object),
		);
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeRequested,
				format: 'webp',
				width: 6,
				height: 3,
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.ResizeCompleted,
				cacheKey: 'public/sample.png:6x3:webp',
				format: 'webp',
				status: 'success',
			}),
		]);
	});

	it('스토리지 앱에서 원본 이미지를 찾지 못하면 404를 반환한다', () => {
		fetchSpy.mockResolvedValue(
			createFetchResponse(Buffer.from('missing'), { status: 404 }),
		);

		return internalAuthorized(
			request(app.getHttpServer()).get('/image/public/missing.png'),
		).expect(404);
	});
});
