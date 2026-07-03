import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

const adminToken = 'test-admin-token';
const uploadEvent = {
	schemaVersion: 1,
	eventId: 'evt-e2e-upload-1',
	eventType: 'image.upload.completed',
	occurredAt: '2026-07-01T00:00:00.000Z',
	sourceApp: 'storage',
	environment: 'test',
	imageId: 100,
	path: 'products/image',
	name: 'sample.png',
	imageKey: 'products/image/sample.png',
	format: 'png',
	inputBytes: 1000,
	outputBytes: 800,
	durationMs: 15,
	status: 'success',
};

describe('텔레메트리 API e2e', () => {
	let app: INestApplication;

	beforeEach(async () => {
		const moduleFixture: TestingModule = await Test.createTestingModule({
			imports: [AppModule],
		}).compile();

		app = moduleFixture.createNestApplication();
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	it('관리자 상태 확인 요청에 정상 상태를 반환한다', async () => {
		await request(app.getHttpServer())
			.get('/api/admin/health')
			.set('x-admin-token', adminToken)
			.expect(200)
			.expect(({ body }) => {
				expect(body).toMatchObject({
					ok: true,
					service: 'telemetry-api',
					storage: { kind: 'memory', connected: true },
				});
			});
	});

	it('대시보드 요약 요청에 핵심 지표를 반환한다', async () => {
		await seedEvents(app);

		await request(app.getHttpServer())
			.get('/api/admin/dashboard/summary')
			.set('x-admin-token', adminToken)
			.query(testRange())
			.expect(200)
			.expect(({ body }) => {
				expect(body).toMatchObject({
					totalEvents: 3,
					totalUploads: 1,
					totalResizes: 0,
					cacheHitRate: 0.5,
					failureRate: 0,
					totalInputBytes: 1000,
					totalOutputBytes: 800,
				});
			});
	});

	it('대시보드 시계열 요청에 시간대별 지표를 반환한다', async () => {
		await seedEvents(app);

		await request(app.getHttpServer())
			.get('/api/admin/dashboard/timeseries')
			.set('x-admin-token', adminToken)
			.query({ ...testRange(), interval: 'hour' })
			.expect(200)
			.expect(({ body }) => {
				expect(body.interval).toBe('hour');
				expect(body.points).toHaveLength(2);
				expect(body.points[0]).toMatchObject({
					bucketStart: '2026-07-01T00:00:00.000Z',
					totalEvents: 3,
					cacheHits: 1,
					cacheMisses: 1,
				});
				expect(body.points[1]).toMatchObject({
					totalEvents: 0,
				});
			});
	});

	it('이벤트 목록 요청에 필터링된 이벤트 목록을 반환한다', async () => {
		await seedEvents(app);

		await request(app.getHttpServer())
			.get('/api/admin/events')
			.set('x-admin-token', adminToken)
			.query({ eventType: 'image.cache.hit', limit: 1 })
			.expect(200)
			.expect(({ body }) => {
				expect(body.items).toHaveLength(1);
				expect(body.items[0]).toMatchObject({
					eventId: 'evt-e2e-hit-1',
					eventType: 'image.cache.hit',
				});
			});
	});

	it('이미지 목록 요청에 이미지 집계 목록을 반환한다', async () => {
		await seedEvents(app);

		await request(app.getHttpServer())
			.get('/api/admin/images')
			.set('x-admin-token', adminToken)
			.query({ sort: 'reads', order: 'desc' })
			.expect(200)
			.expect(({ body }) => {
				expect(body.items[0]).toMatchObject({
					imageKey: 'products/image/sample.png',
					totalReads: 2,
					totalCacheHits: 1,
					totalCacheMisses: 1,
					cacheHitRate: 0.5,
				});
			});
	});

	it('이미지 상세 확장 엔드포인트는 이벤트와 variant를 반환한다', async () => {
		await seedEvents(app);
		await request(app.getHttpServer())
			.post('/api/ingestion/events')
			.send({
				...uploadEvent,
				eventId: 'evt-e2e-resize-1',
				eventType: 'image.resize.completed',
				occurredAt: '2026-07-01T00:30:00.000Z',
				sourceApp: 'resize',
				width: 120,
				height: 80,
				outputBytes: 400,
				durationMs: 25,
			})
			.expect(202);

		const encodedImageKey = encodeURIComponent('products/image/sample.png');
		await request(app.getHttpServer())
			.get(`/api/admin/images/${encodedImageKey}/events`)
			.set('x-admin-token', adminToken)
			.expect(200)
			.expect(({ body }) => {
				expect(body.items).toHaveLength(4);
			});
		await request(app.getHttpServer())
			.get(`/api/admin/images/${encodedImageKey}/variants`)
			.set('x-admin-token', adminToken)
			.expect(200)
			.expect(({ body }) => {
				expect(body.items[0]).toMatchObject({
					variantKey: 'products/image/sample.png:120x80:png',
				});
			});
	});

	it('잘못된 기간 쿼리는 400을 반환한다', async () => {
		await request(app.getHttpServer())
			.get('/api/admin/events')
			.set('x-admin-token', adminToken)
			.query({ from: 'not-date' })
			.expect(400);
	});

	it('목록 제한 값이 최대값을 넘으면 400을 반환한다', async () => {
		await request(app.getHttpServer())
			.get('/api/admin/events')
			.set('x-admin-token', adminToken)
			.query({ limit: 101 })
			.expect(400);
	});

	it('관리자 인증이 없으면 401을 반환한다', async () => {
		await request(app.getHttpServer()).get('/api/admin/health').expect(401);
	});

	it('관리자 API로 클라이언트 서비스를 등록하고 API key를 발급/폐기한다', async () => {
		const created = await request(app.getHttpServer())
			.post('/api/admin/client-services')
			.set('x-admin-token', adminToken)
			.send({
				slug: 'catalog-api',
				name: 'Catalog API',
				owner: 'commerce-team',
			})
			.expect(201)
			.then(({ body }) => body);

		expect(created).toMatchObject({
			slug: 'catalog-api',
			name: 'Catalog API',
			status: 'ACTIVE',
			keyCount: 0,
		});

		const keyResult = await request(app.getHttpServer())
			.post(`/api/admin/client-services/${created.id}/keys`)
			.set('x-admin-token', adminToken)
			.send({ name: 'local backend key', scopes: { upload: true } })
			.expect(201)
			.then(({ body }) => body);

		expect(keyResult.apiKey).toMatch(/^fs_/);
		expect(keyResult.key).toMatchObject({
			clientServiceId: created.id,
			keyPrefix: expect.any(String),
		});
		expect(keyResult.key).not.toHaveProperty('keyHash');

		await request(app.getHttpServer())
			.post(
				`/api/admin/client-services/${created.id}/keys/${keyResult.key.id}/revoke`,
			)
			.set('x-admin-token', adminToken)
			.expect(201)
			.expect(({ body }) => {
				expect(body.revokedAt).toEqual(expect.any(String));
			});

		await request(app.getHttpServer())
			.get(`/api/admin/client-services/${created.id}`)
			.set('x-admin-token', adminToken)
			.expect(200)
			.expect(({ body }) => {
				expect(body.keyCount).toBe(1);
				expect(body.activeKeyCount).toBe(0);
			});
	});
});

async function seedEvents(app: INestApplication) {
	await request(app.getHttpServer())
		.post('/api/ingestion/events')
		.send(uploadEvent)
		.expect(202);
	await request(app.getHttpServer())
		.post('/api/ingestion/events')
		.send({
			...uploadEvent,
			eventId: 'evt-e2e-hit-1',
			eventType: 'image.cache.hit',
			occurredAt: '2026-07-01T00:10:00.000Z',
			sourceApp: 'cache',
			cacheKey: 'sample-hit',
			inputBytes: undefined,
			outputBytes: undefined,
			durationMs: 4,
		})
		.expect(202);
	await request(app.getHttpServer())
		.post('/api/ingestion/events')
		.send({
			...uploadEvent,
			eventId: 'evt-e2e-miss-1',
			eventType: 'image.cache.miss',
			occurredAt: '2026-07-01T00:20:00.000Z',
			sourceApp: 'cache',
			cacheKey: 'sample-miss',
			inputBytes: undefined,
			outputBytes: undefined,
			durationMs: 6,
		})
		.expect(202);
}

function testRange() {
	return {
		from: '2026-07-01T00:00:00.000Z',
		to: '2026-07-01T01:00:00.000Z',
	};
}
