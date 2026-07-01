jest.mock('src/config', () => {
	class AppConfig {
		INTERNAL_API_KEY?: string;
	}

	return { AppConfig };
});

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import { rm } from 'fs/promises';
import * as path from 'path';
import { of } from 'rxjs';
import * as request from 'supertest';
import * as sharp from 'sharp';
import { AppConfig } from 'src/config';
import { Root } from '../src/enum';
import { AppController } from '../src/app.controller';
import { ImageController } from '../src/modules/image/image.controller';
import { ImageService } from '../src/modules/image/image.service';
import { InternalApiKeyGuard } from '../src/modules/image/internal-api-key.guard';
import { ImageManager } from '../src/modules/image/strategies/manager';
import { JpegStrategy } from '../src/modules/image/strategies/sharp/jpeg.strategy';
import { PngStrategy } from '../src/modules/image/strategies/sharp/png.strategy';

const testApiKey = 'test-internal-key';
const assetRoot = path.resolve(Root, 'assets', 'e2e-storage');
const tempRoot = path.resolve(Root, 'temp');

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

describe('스토리지 앱 e2e', () => {
	let app: INestApplication;
	let imageClient: jest.Mocked<Pick<ClientKafka, 'emit'>>;

	beforeEach(async () => {
		await rm(assetRoot, { recursive: true, force: true });
		await rm(tempRoot, { recursive: true, force: true });

		imageClient = {
			emit: jest.fn().mockReturnValue(of({ ok: true })),
		};

		const moduleFixture: TestingModule = await Test.createTestingModule({
			controllers: [AppController, ImageController],
			providers: [
				ImageService,
				InternalApiKeyGuard,
				PngStrategy,
				JpegStrategy,
				ImageManager,
				{
					provide: AppConfig,
					useValue: { INTERNAL_API_KEY: testApiKey },
				},
				{
					provide: 'IMAGE_MICROSERVICE',
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
		await rm(assetRoot, { recursive: true, force: true });
		await rm(tempRoot, { recursive: true, force: true });
	});

	it('GET /health-check 요청에 OK를 반환한다', () => {
		return request(app.getHttpServer())
			.get('/health-check')
			.expect(200)
			.expect('OK');
	});

	it('내부 API 키가 없으면 이미지 업로드를 거부한다', async () => {
		const image = await createPngImage();

		await request(app.getHttpServer())
			.post('/image')
			.field('id', '1')
			.field('path', 'e2e-storage/image')
			.attach('file', image, {
				filename: 'sample.png',
				contentType: 'image/png',
			})
			.expect(401);
	});

	it('업로드 이미지를 path/image/name 규칙으로 저장하고 조회와 삭제를 수행한다', async () => {
		const image = await createPngImage();

		await request(app.getHttpServer())
			.post('/image')
			.set('x-internal-api-key', testApiKey)
			.field('id', '100')
			.field('path', 'e2e-storage/image')
			.attach('file', image, {
				filename: 'sample.png',
				contentType: 'image/png',
			})
			.expect(201);

		expect(imageClient.emit).toHaveBeenCalledWith('image-topic', {
			key: 'uploadResult-json',
			value: expect.stringContaining('"id":100'),
		});

		const getResponse = await request(app.getHttpServer())
			.get('/image/e2e-storage/sample.png')
			.expect(200)
			.expect('content-type', /image\/png/);
		const metadata = await sharp(Buffer.from(getResponse.body)).metadata();
		expect(metadata.format).toBe('png');
		expect(metadata.width).toBe(8);
		expect(metadata.height).toBe(6);

		await request(app.getHttpServer())
			.delete('/image')
			.set('x-internal-api-key', testApiKey)
			.query({
				id: 100,
				path: 'e2e-storage/image',
				beforeName: 'sample.png',
			})
			.expect(200);

		await request(app.getHttpServer())
			.get('/image/e2e-storage/sample.png')
			.expect(404);
	});

	it('업로드 시 beforeName이 있으면 이전 이미지를 삭제한다', async () => {
		const previousImage = await createPngImage();
		const nextImage = await createPngImage();

		await request(app.getHttpServer())
			.post('/image')
			.set('x-internal-api-key', testApiKey)
			.field('id', '200')
			.field('path', 'e2e-storage/image')
			.attach('file', previousImage, {
				filename: 'previous.png',
				contentType: 'image/png',
			})
			.expect(201);

		await request(app.getHttpServer())
			.post('/image')
			.set('x-internal-api-key', testApiKey)
			.field('id', '201')
			.field('path', 'e2e-storage/image')
			.field('beforeName', 'previous.png')
			.attach('file', nextImage, {
				filename: 'next.png',
				contentType: 'image/png',
			})
			.expect(201);

		await request(app.getHttpServer())
			.get('/image/e2e-storage/previous.png')
			.expect(404);
		await request(app.getHttpServer())
			.get('/image/e2e-storage/next.png')
			.expect(200);
	});
});
