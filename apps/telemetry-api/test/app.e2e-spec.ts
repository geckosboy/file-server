import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { LifecycleIngestionService } from '../src/modules/lifecycle/lifecycle-ingestion.service';

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

const lifecycleCompletedEvent = {
	schemaVersion: 1,
	eventId: 'life-e2e-upload-1',
	eventType: 'image.upload.completed',
	occurredAt: '2026-07-01T00:05:00.000Z',
	sourceApp: 'storage',
	environment: 'test',
	clientServiceId: 'service-e2e',
	clientServiceSlug: 'catalog-api',
	requestId: 'req-life-e2e-1',
	imageId: 101,
	path: 'products/image',
	name: 'sample.png',
	imageKey: 'products/image/sample.png',
	format: 'png',
	inputBytes: 1000,
	outputBytes: 800,
	durationMs: 15,
	status: 'success',
};

const lifecycleFailedEvent = {
	schemaVersion: 1,
	eventId: 'life-e2e-upload-failed-1',
	eventType: 'image.upload.failed',
	occurredAt: '2026-07-01T00:06:00.000Z',
	sourceApp: 'storage',
	environment: 'test',
	clientServiceId: 'service-e2e',
	clientServiceSlug: 'catalog-api',
	requestId: 'req-life-e2e-failed-1',
	imageId: 102,
	path: 'products/image',
	name: 'broken.txt',
	imageKey: 'products/image/broken.txt',
	format: 'unknown',
	inputBytes: 9,
	status: 'failed',
	errorCode: 'BadRequestException',
	errorMessage: 'bad image',
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
					kafka: {
						enabled: false,
						connected: false,
						consumerLag: null,
						topic: 'file.image.events.v1',
					},
					lifecycleKafka: {
						enabled: false,
						connected: false,
						consumerLag: null,
						topic: 'file.image.lifecycle.v1',
					},
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

	it('리사이징 추천 엔드포인트는 서비스별 요청 횟수와 예상 절감 효과를 반환한다', async () => {
		await seedResizeRecommendationEvents(app);

		await request(app.getHttpServer())
			.get('/api/admin/image-resize-recommendations')
			.set('x-admin-token', adminToken)
			.query({
				clientServiceSlug: 'catalog-api',
				minRequests: 2,
				limit: 10,
			})
			.expect(200)
			.expect(({ body }) => {
				expect(body.threshold).toEqual({ minRequests: 2 });
				expect(body.items).toEqual([
					expect.objectContaining({
						clientServiceId: 'service-e2e',
						clientServiceSlug: 'catalog-api',
						width: 400,
						height: 400,
						format: 'webp',
						requestCount: 2,
						imageCount: 1,
						estimatedSavedResizeMs: 30,
						recommended: true,
					}),
				]);
			});
	});

	it('lifecycle 이벤트 목록 요청에 upload completed/failed 이벤트를 반환한다', async () => {
		await seedLifecycleEvents(app);

		await request(app.getHttpServer())
			.get('/api/admin/lifecycle-events')
			.set('x-admin-token', adminToken)
			.query({ eventType: 'image.upload.failed', status: 'failed', limit: 10 })
			.expect(200)
			.expect(({ body }) => {
				expect(body.items).toHaveLength(1);
				expect(body.items[0]).toMatchObject({
					eventId: 'life-e2e-upload-failed-1',
					eventType: 'image.upload.failed',
					clientServiceSlug: 'catalog-api',
					errorCode: 'BadRequestException',
				});
			});
	});

	it('이미지별 lifecycle 이벤트 요청에 해당 이미지 이벤트만 반환한다', async () => {
		await seedLifecycleEvents(app);

		const encodedImageKey = encodeURIComponent('products/image/sample.png');
		await request(app.getHttpServer())
			.get(`/api/admin/images/${encodedImageKey}/lifecycle-events`)
			.set('x-admin-token', adminToken)
			.expect(200)
			.expect(({ body }) => {
				expect(
					body.items.map((item: { eventId: string }) => item.eventId),
				).toEqual(['life-e2e-upload-1']);
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

	it('관리자 API로 클라이언트 서비스를 등록하고 API key와 lifecycle subscription을 관리한다', async () => {
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

		const subscription = await request(app.getHttpServer())
			.post(`/api/admin/client-services/${created.id}/lifecycle-subscriptions`)
			.set('x-admin-token', adminToken)
			.send({
				eventType: 'image.upload.completed',
				consumerGroup: 'catalog-image-consumer',
				description: '상품 서비스가 업로드 완료 이벤트를 소비합니다.',
			})
			.expect(201)
			.then(({ body }) => body);

		expect(subscription).toMatchObject({
			clientServiceId: created.id,
			eventType: 'image.upload.completed',
			consumerGroup: 'catalog-image-consumer',
			isEnabled: true,
			description: '상품 서비스가 업로드 완료 이벤트를 소비합니다.',
		});

		await request(app.getHttpServer())
			.patch(
				`/api/admin/client-services/${created.id}/lifecycle-subscriptions/${subscription.id}`,
			)
			.set('x-admin-token', adminToken)
			.send({
				eventType: 'image.upload.failed',
				consumerGroup: 'catalog-image-failure-consumer',
				isEnabled: false,
				description: '실패 이벤트만 소비합니다.',
			})
			.expect(200)
			.expect(({ body }) => {
				expect(body).toMatchObject({
					eventType: 'image.upload.failed',
					consumerGroup: 'catalog-image-failure-consumer',
					isEnabled: false,
					description: '실패 이벤트만 소비합니다.',
				});
			});

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
				expect(body.subscriptionCount).toBe(1);
				expect(body.activeSubscriptionCount).toBe(0);
				expect(body.lifecycleSubscriptions).toEqual([
					expect.objectContaining({
						eventType: 'image.upload.failed',
						consumerGroup: 'catalog-image-failure-consumer',
					}),
				]);
			});
	});

	it('관리자 API로 서비스별 이미지 리사이징 정책과 pre-generate variant를 관리한다', async () => {
		const created = await request(app.getHttpServer())
			.post('/api/admin/client-services')
			.set('x-admin-token', adminToken)
			.send({
				slug: 'media-api',
				name: 'Media API',
				owner: 'media-team',
			})
			.expect(201)
			.then(({ body }) => body);

		await request(app.getHttpServer())
			.get(`/api/admin/client-services/${created.id}/image-resize-policy`)
			.set('x-admin-token', adminToken)
			.expect(200)
			.expect(({ body }) => {
				expect(body).toMatchObject({
					clientServiceId: created.id,
					mode: 'ON_DEMAND',
					variants: [],
				});
			});

		await request(app.getHttpServer())
			.patch(`/api/admin/client-services/${created.id}/image-resize-policy`)
			.set('x-admin-token', adminToken)
			.send({ mode: 'PRE_GENERATE' })
			.expect(200)
			.expect(({ body }) => {
				expect(body.mode).toBe('PRE_GENERATE');
			});

		const variant = await request(app.getHttpServer())
			.post(
				`/api/admin/client-services/${created.id}/image-resize-policy/variants`,
			)
			.set('x-admin-token', adminToken)
			.send({
				width: 400,
				height: 400,
				format: 'webp',
				description: '미디어 썸네일',
			})
			.expect(201)
			.then(({ body }) => body);

		expect(variant).toMatchObject({
			width: 400,
			height: 400,
			format: 'webp',
			isEnabled: true,
			description: '미디어 썸네일',
		});

		await request(app.getHttpServer())
			.patch(
				`/api/admin/client-services/${created.id}/image-resize-policy/variants/${variant.id}`,
			)
			.set('x-admin-token', adminToken)
			.send({ isEnabled: false, description: '잠시 끔' })
			.expect(200)
			.expect(({ body }) => {
				expect(body).toMatchObject({
					isEnabled: false,
					description: '잠시 끔',
				});
			});

		await request(app.getHttpServer())
			.delete(
				`/api/admin/client-services/${created.id}/image-resize-policy/variants/${variant.id}`,
			)
			.set('x-admin-token', adminToken)
			.expect(200)
			.expect(({ body }) => {
				expect(body.id).toBe(variant.id);
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

async function seedLifecycleEvents(app: INestApplication) {
	const lifecycleIngestionService = app.get(LifecycleIngestionService);
	await lifecycleIngestionService.ingest(lifecycleCompletedEvent);
	await lifecycleIngestionService.ingest(lifecycleFailedEvent);
}

async function seedResizeRecommendationEvents(app: INestApplication) {
	for (const [index, durationMs] of [10, 20].entries()) {
		await request(app.getHttpServer())
			.post('/api/ingestion/events')
			.send({
				...uploadEvent,
				eventId: `evt-e2e-rec-${index + 1}`,
				eventType: 'image.resize.completed',
				occurredAt: `2026-07-01T00:4${index}:00.000Z`,
				sourceApp: 'resize',
				clientServiceId: 'service-e2e',
				clientServiceSlug: 'catalog-api',
				width: 400,
				height: 400,
				format: 'webp',
				outputBytes: 300,
				durationMs,
			})
			.expect(202);
	}
	await request(app.getHttpServer())
		.post('/api/ingestion/events')
		.send({
			...uploadEvent,
			eventId: 'evt-e2e-rec-pregenerated-skip',
			eventType: 'image.resize.completed',
			occurredAt: '2026-07-01T00:45:00.000Z',
			sourceApp: 'resize',
			clientServiceId: 'service-e2e',
			clientServiceSlug: 'catalog-api',
			width: 400,
			height: 400,
			format: 'webp',
			cacheKey: 'products/image/sample.png:400x400:webp',
			outputBytes: 300,
			durationMs: 999,
		})
		.expect(202);
}

function testRange() {
	return {
		from: '2026-07-01T00:00:00.000Z',
		to: '2026-07-01T01:00:00.000Z',
	};
}
