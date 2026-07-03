jest.mock('src/config', () => ({
	envConfig: {
		STORAGE_SERVER: 'http://storage.test',
	},
}));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import {
	ClientServiceApiKeyGuard,
	ClientServiceAuthService,
} from '@file/database';
import { of } from 'rxjs';
import * as request from 'supertest';
import * as sharp from 'sharp';
import { AppController } from '../src/app.controller';
import { ImageController } from '../src/modules/image/image.controller';
import { ImageManager } from '../src/modules/image/manager';
import { ImageService } from '../src/modules/image/image.service';
import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEventType,
} from '../src/modules/image/image.telemetry';

const testClientApiKey = 'fs_prefix_secret';
const testRequestId = 'req-resize-e2e';

type KafkaEmitPayload = { key: string; value: string };

const parseKafkaPayload = (payload: KafkaEmitPayload) =>
	JSON.parse(payload.value) as Record<string, unknown>;

const createFetchResponse = (body: Buffer, status = 200) =>
	new Response(new Uint8Array(body), { status });

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

const authorized = (agent: request.Test) =>
	agent
		.set('x-client-api-key', testClientApiKey)
		.set('x-request-id', testRequestId);

describe('리사이즈 앱 e2e', () => {
	let app: INestApplication;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;
	let imageClient: jest.Mocked<Pick<ClientKafka, 'emit'>>;
	let originalImage: Buffer;
	let authService: ReturnType<typeof createAuthService>;

	const getTelemetryPayloads = () =>
		imageClient.emit.mock.calls
			.filter(([topic]) => topic === IMAGE_TELEMETRY_TOPIC)
			.map(([, payload]) => parseKafkaPayload(payload as KafkaEmitPayload));

	beforeEach(async () => {
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
		authService = createAuthService();

		const moduleFixture: TestingModule = await Test.createTestingModule({
			controllers: [AppController, ImageController],
			providers: [
				ImageService,
				ClientServiceApiKeyGuard,
				{
					provide: ClientServiceAuthService,
					useValue: authService,
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
		jest.restoreAllMocks();
	});

	it('상태 확인 요청에 정상 응답을 반환한다', () => {
		return request(app.getHttpServer())
			.get('/health-check')
			.expect(200)
			.expect('OK');
	});

	it('클라이언트 서비스 API 키가 없으면 이미지 조회를 거부한다', () => {
		return request(app.getHttpServer())
			.get('/image/public/sample.png')
			.expect(401);
	});

	it('크기 쿼리가 없으면 스토리지 앱의 원본 이미지를 반환한다', async () => {
		const response = await authorized(
			request(app.getHttpServer()).get('/image/public/sample.png'),
		)
			.expect(200)
			.expect('content-type', /image\/png/);

		expect(Buffer.from(response.body).equals(originalImage)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith(
			'http://storage.test/image/public/sample.png',
			{
				method: 'get',
				headers: {
					'x-client-api-key': testClientApiKey,
					'x-request-id': testRequestId,
				},
			},
		);
	});

	it('너비와 높이 쿼리가 있으면 리사이즈된 이미지를 반환한다', async () => {
		const response = await authorized(
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

	it('스토리지 앱에서 원본 이미지를 찾지 못하면 404를 반환한다', () => {
		fetchSpy.mockResolvedValue(
			createFetchResponse(Buffer.from('missing'), 404),
		);

		return authorized(
			request(app.getHttpServer()).get('/image/public/missing.png'),
		).expect(404);
	});
});
