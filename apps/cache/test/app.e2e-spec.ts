jest.mock('src/config', () => ({
	envConfig: {
		RESIZING_SERVER: 'http://resize.test',
	},
}));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppController } from '../src/app.controller';
import { ImageController } from '../src/modules/image/image.controller';
import { ImageService } from '../src/modules/image/image.service';
import { CacheService } from '../src/modules/node-cache/cache.service';

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

describe('캐시 앱 e2e', () => {
	let app: INestApplication;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;

	beforeEach(async () => {
		fetchSpy = jest.spyOn(globalThis, 'fetch');

		const moduleFixture: TestingModule = await Test.createTestingModule({
			controllers: [AppController, ImageController],
			providers: [
				ImageService,
				CacheService,
				{
					provide: 'CACHE_TTL',
					useValue: 600,
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

	it('GET /health-check 요청에 OK를 반환한다', () => {
		return request(app.getHttpServer())
			.get('/health-check')
			.expect(200)
			.expect('OK');
	});

	it('캐시 미스 시 리사이즈 앱 이미지를 반환하고 다음 요청부터 캐시 이미지를 반환한다', async () => {
		const resizedImage = Buffer.from('resized-image');
		fetchSpy.mockResolvedValue(
			createFetchResponse(resizedImage, { contentType: 'image/png' }),
		);

		const firstResponse = await request(app.getHttpServer())
			.get('/image/public/sample.png')
			.query({ width: 32, height: 16 })
			.expect(200)
			.expect('content-type', /image\/png/);

		const secondResponse = await request(app.getHttpServer())
			.get('/image/public/sample.png')
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
	});

	it('리사이즈 앱이 이미지 없음으로 응답하면 404를 반환한다', () => {
		fetchSpy.mockResolvedValue(
			createFetchResponse(Buffer.from('missing'), { status: 404 }),
		);

		return request(app.getHttpServer())
			.get('/image/public/missing.png')
			.expect(404);
	});
});
