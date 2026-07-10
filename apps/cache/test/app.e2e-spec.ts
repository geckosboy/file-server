jest.mock('src/config', () => ({
	envConfig: {
		RESIZING_SERVER: 'http://resize.test',
		INTERNAL_API_KEY: 'internal-test-key',
	},
}));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import {
	ClientServiceApiKeyGuard,
	ClientServiceAuthService,
	ClientServiceAuthorizationService,
	INTERNAL_API_KEY_HEADER,
	INTERNAL_CLIENT_CONTEXT_HEADER,
	INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER,
} from '@file/database';
import { of } from 'rxjs';
import request, { type Test as SuperTestRequest } from 'supertest';
import { AppController } from '../src/app.controller';
import { ImageController } from '../src/modules/image/image.controller';
import { ImageService } from '../src/modules/image/image.service';
import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEventType,
} from '../src/modules/image/image.telemetry';
import { CacheService } from '../src/modules/node-cache/cache.service';

const testClientApiKey = 'fs_prefix_secret';
const testRequestId = 'req-cache-e2e';

type KafkaEmitPayload = { key: string; value: string };

const parseKafkaPayload = (payload: KafkaEmitPayload) =>
	JSON.parse(payload.value) as Record<string, unknown>;

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

describe('캐시 앱 e2e', () => {
	let app: INestApplication;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;
	let imageClient: jest.Mocked<Pick<ClientKafka, 'emit'>>;
	let authService: ReturnType<typeof createAuthService>;
	let authorization: { authorize: jest.Mock };

	const getTelemetryPayloads = () =>
		imageClient.emit.mock.calls
			.filter(([topic]) => topic === IMAGE_TELEMETRY_TOPIC)
			.map(([, payload]) => parseKafkaPayload(payload as KafkaEmitPayload));

	beforeEach(async () => {
		fetchSpy = jest.spyOn(globalThis, 'fetch');
		imageClient = {
			emit: jest.fn().mockReturnValue(of({ ok: true })),
		};
		authService = createAuthService();
		authorization = {
			authorize: jest.fn().mockResolvedValue({ allowed: true }),
		};

		const moduleFixture: TestingModule = await Test.createTestingModule({
			controllers: [AppController, ImageController],
			providers: [
				ImageService,
				ClientServiceApiKeyGuard,
				{
					provide: ClientServiceAuthService,
					useValue: authService,
				},
				{
					provide: ClientServiceAuthorizationService,
					useValue: authorization,
				},
				CacheService,
				{
					provide: 'CACHE_TTL',
					useValue: 600,
				},
				{
					provide: 'CACHE_IMAGE_MICROSERVICE',
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

	it('캐시 미스 시 리사이즈 앱 이미지를 반환하고 다음 요청부터 캐시 이미지를 반환한다', async () => {
		const resizedImage = Buffer.from('resized-image');
		fetchSpy.mockResolvedValue(
			createFetchResponse(resizedImage, { contentType: 'image/png' }),
		);

		const firstResponse = await authorized(
			request(app.getHttpServer()).get('/image/public/sample.png'),
		)
			.query({ width: 32, height: 16 })
			.expect(200)
			.expect('content-type', /image\/png/);

		const secondResponse = await authorized(
			request(app.getHttpServer()).get('/image/public/sample.png'),
		)
			.query({ width: 32, height: 16 })
			.expect(200)
			.expect('content-type', /image\/png/);

		expect(Buffer.from(firstResponse.body).equals(resizedImage)).toBe(true);
		expect(Buffer.from(secondResponse.body).equals(resizedImage)).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const requestedUrl = new URL(String(fetchSpy.mock.calls[0][0]));
		expect(`${requestedUrl.origin}${requestedUrl.pathname}`).toBe(
			'http://resize.test/image/public/sample.png',
		);
		expect(requestedUrl.searchParams.get('width')).toBe('32');
		expect(requestedUrl.searchParams.get('height')).toBe('16');
		const fetchOptions = fetchSpy.mock.calls[0][1] as RequestInit;
		expect(fetchOptions).toEqual({
			headers: expect.objectContaining({
				[INTERNAL_API_KEY_HEADER]: 'internal-test-key',
				[INTERNAL_CLIENT_CONTEXT_HEADER]: expect.any(String),
				[INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER]: expect.any(String),
			}),
		});
		expect(JSON.stringify(fetchOptions.headers)).not.toContain(
			testClientApiKey,
		);
		expect(getTelemetryPayloads()).toEqual([
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheMiss,
				cacheKey: 'service-1|public|32|16|png|sample.png',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: testRequestId,
				status: 'success',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheStored,
				cacheKey: 'service-1|public|32|16|png|sample.png',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: testRequestId,
				status: 'success',
			}),
			expect.objectContaining({
				eventType: ImageTelemetryEventType.CacheHit,
				cacheKey: 'service-1|public|32|16|png|sample.png',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: testRequestId,
				status: 'success',
			}),
		]);
	});

	it('리사이즈 앱이 이미지 없음으로 응답하면 404를 반환한다', () => {
		fetchSpy.mockResolvedValue(
			createFetchResponse(Buffer.from('missing'), { status: 404 }),
		);

		return authorized(
			request(app.getHttpServer()).get('/image/public/missing.png'),
		).expect(404);
	});
});
