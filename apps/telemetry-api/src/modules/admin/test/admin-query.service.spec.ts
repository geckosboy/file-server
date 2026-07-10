import { AdminQueryService } from '.././admin-query.service';
import { IngestionService } from '../../ingestion/ingestion.service';
import { LifecycleIngestionService } from '../../lifecycle/lifecycle-ingestion.service';
import { InMemoryLifecycleRepository } from '../../lifecycle/lifecycle.repository';
import { InMemoryTelemetryRepository } from '../../telemetry/telemetry.repository';
import { InMemoryAdminAnalyticsRepository } from '../in-memory-admin-analytics.repository';
import { TelemetryKafkaConsumerStatusService } from '../../kafka-ingestion/kafka-ingestion.status';
import { LifecycleKafkaConsumerStatusService } from '../../kafka-lifecycle/kafka-lifecycle.status';
import { PrismaService } from '@file/database';

const baseEvent = {
	schemaVersion: 1,
	occurredAt: '2026-07-01T00:00:00.000Z',
	sourceApp: 'storage',
	environment: 'test',
	path: 'products/image',
	name: 'sample.png',
	imageKey: 'products/image/sample.png',
	format: 'png',
	status: 'success',
};

describe('관리자 조회 서비스', () => {
	const originalReconciliationCompatFlag =
		process.env.IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED;
	let ingestionService: IngestionService;
	let lifecycleIngestionService: LifecycleIngestionService;
	let queryService: AdminQueryService;

	beforeEach(async () => {
		const repository = new InMemoryTelemetryRepository();
		const lifecycleRepository = new InMemoryLifecycleRepository();
		ingestionService = new IngestionService(repository);
		lifecycleIngestionService = new LifecycleIngestionService(
			lifecycleRepository,
		);
		queryService = new AdminQueryService(
			repository,
			lifecycleRepository,
			new InMemoryAdminAnalyticsRepository(repository),
		);
		await seedFixture();
	});

	afterEach(() => {
		if (originalReconciliationCompatFlag === undefined) {
			delete process.env.IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED;
		} else {
			process.env.IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED =
				originalReconciliationCompatFlag;
		}
	});

	it('대시보드 요약에서 캐시 hit율을 계산한다', async () => {
		const summary = await queryService.getSummary(testRange());

		expect(summary.cacheHitRate).toBe(0.5);
		expect(summary.cacheMissRate).toBe(0.5);
	});

	it('DB 또는 enabled Kafka가 준비되지 않으면 top-level ok=false다', async () => {
		const repository = new InMemoryTelemetryRepository();
		const lifecycleRepository = new InMemoryLifecycleRepository();
		jest.spyOn(repository, 'isConnected').mockResolvedValue(false);
		const kafka = new TelemetryKafkaConsumerStatusService();
		kafka.configure({
			enabled: true,
			brokers: ['kafka:9092'],
			clientId: 'telemetry-api',
			groupId: 'file-telemetry-api',
			topic: 'file.image.events.v1',
			dlqTopic: 'file.image.events.v1.dlq',
			fromBeginning: false,
			retryMaxAttempts: 3,
			retryBackoffMs: 100,
			connectRetryBackoffMs: 500,
			connectRetryMaxBackoffMs: 10_000,
			lagRefreshIntervalMs: 5_000,
		});
		const lifecycleKafka = new LifecycleKafkaConsumerStatusService();

		const health = await new AdminQueryService(
			repository,
			lifecycleRepository,
			new InMemoryAdminAnalyticsRepository(repository),
			kafka,
			lifecycleKafka,
		).getHealth();

		expect(health).toMatchObject({
			ok: false,
			storage: { connected: false },
			kafka: { enabled: true, ready: false },
			lifecycleKafka: { enabled: false, ready: true },
		});
	});

	it('outbox pending/retry/dead-letter 상태를 operational metrics로 반환한다', async () => {
		const repository = new InMemoryTelemetryRepository();
		const lifecycleRepository = new InMemoryLifecycleRepository();
		const count = jest
			.fn()
			.mockResolvedValueOnce(2)
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(3)
			.mockResolvedValueOnce(4)
			.mockResolvedValueOnce(5);
		const prisma = {
			imageLifecycleOutbox: {
				count,
				aggregate: jest.fn().mockResolvedValue({
					_sum: { attempts: 7 },
					_min: { createdAt: new Date(Date.now() - 1_000) },
				}),
			},
		} as unknown as PrismaService;

		const health = await new AdminQueryService(
			repository,
			lifecycleRepository,
			new InMemoryAdminAnalyticsRepository(repository),
			undefined,
			undefined,
			prisma,
		).getHealth();

		expect(health.operationalMetrics.outbox).toMatchObject({
			available: true,
			pendingCount: 2,
			publishingCount: 1,
			failedCount: 3,
			deadLetterCount: 4,
			publishedCount: 5,
			retryCount: 7,
			oldestUnpublishedAgeMs: expect.any(Number),
		});
	});

	it('이미지 lifecycle admin health는 DB 상태별 age와 variant job lag를 반환한다', async () => {
		delete process.env.IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED;
		const repository = new InMemoryTelemetryRepository();
		const lifecycleRepository = new InMemoryLifecycleRepository();
		const prisma = createImageLifecycleMetricsPrisma();

		const health = await new AdminQueryService(
			repository,
			lifecycleRepository,
			new InMemoryAdminAnalyticsRepository(repository),
			undefined,
			undefined,
			prisma,
		).getHealth();

		expect(health.operationalMetrics.imageLifecycle).toMatchObject({
			available: true,
			assets: {
				pending: 2,
				deleting: 1,
				failed: 1,
				oldestPendingAgeMs: 120_000,
				oldestDeletingAgeMs: 60_000,
			},
			variants: {
				pending: 3,
				deleting: 2,
				failed: 2,
				oldestPendingAgeMs: 90_000,
				oldestDeletingAgeMs: 45_000,
			},
			jobs: {
				pending: 4,
				processing: 1,
				failed: 3,
				oldestActiveAgeMs: 75_000,
				lagMs: 75_000,
			},
			reconciliation: {
				supported: true,
				orphanCount: 7,
				repairedCount: 8,
				failedCount: 2,
			},
		});
		expect(health.operationalMetrics.reconciliation).toMatchObject({
			supported: true,
			orphanCount: 7,
		});
	});

	it('Stage 4 admin reconciliation shape를 flag 기간에는 유지하면서 실제 값을 보존한다', async () => {
		process.env.IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED = 'true';
		const repository = new InMemoryTelemetryRepository();
		const lifecycleRepository = new InMemoryLifecycleRepository();
		const prisma = createImageLifecycleMetricsPrisma();

		const health = await new AdminQueryService(
			repository,
			lifecycleRepository,
			new InMemoryAdminAnalyticsRepository(repository),
			undefined,
			undefined,
			prisma,
		).getHealth();

		expect(health.operationalMetrics.reconciliation).toMatchObject({
			supported: false,
			orphanCount: null,
			repairedCount: 8,
			failedCount: 2,
			transition: {
				imageLifecycleSupported: true,
				imageLifecycleOrphanCount: 7,
				legacyCompatEnabled: true,
			},
		});
		expect(health.operationalMetrics.imageLifecycle.reconciliation).toEqual(
			health.operationalMetrics.reconciliation,
		);
	});

	it('캐시 이벤트가 없으면 hit율을 null로 반환한다', async () => {
		const summary = await queryService.getSummary({
			from: '2026-07-01T02:00:00.000Z',
			to: '2026-07-01T02:59:59.999Z',
		});

		expect(summary.cacheHitRate).toBeNull();
		expect(summary.cacheMissRate).toBeNull();
	});

	it('실패율을 전체 이벤트 대비 실패 이벤트 비율로 계산한다', async () => {
		const summary = await queryService.getSummary(testRange());

		expect(summary.totalEvents).toBe(5);
		expect(summary.failureRate).toBe(0.2);
	});

	it('평균 처리 시간은 durationMs가 있는 이벤트만 기준으로 계산한다', async () => {
		const summary = await queryService.getSummary(testRange());

		expect(summary.avgDurationMs).toBe(30);
	});

	it('처리 시간 p95를 fixture 기준으로 계산한다', async () => {
		const summary = await queryService.getSummary(testRange());

		expect(summary.p95DurationMs).toBe(50);
	});

	it('시간대별 집계는 비어 있는 bucket을 0으로 채운다', async () => {
		const timeseries = await queryService.getTimeseries({
			from: '2026-07-01T00:00:00.000Z',
			to: '2026-07-01T02:00:00.000Z',
			interval: 'hour',
		});

		expect(timeseries.points).toHaveLength(3);
		expect(timeseries.points[1]).toMatchObject({
			bucketStart: '2026-07-01T01:00:00.000Z',
			totalEvents: 0,
			cacheHits: 0,
			cacheMisses: 0,
			cacheHitRate: null,
		});
	});

	it('이벤트 목록은 occurredAt 내림차순으로 페이지네이션한다', async () => {
		const firstPage = await queryService.listEvents({ limit: 2 });
		const secondPage = await queryService.listEvents({
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		const legacyOffsetPage = await queryService.listEvents({
			limit: 2,
			cursor: '2',
		});

		expect(firstPage.items.map((item) => item.eventId)).toEqual([
			'evt-resize-1',
			'evt-failed-1',
		]);
		expect(firstPage.nextCursor).toEqual(expect.any(String));
		expect(firstPage.nextCursor).not.toMatch(/^\d+$/);
		expect(secondPage.items.map((item) => item.eventId)).toEqual([
			'evt-miss-1',
			'evt-hit-1',
		]);
		expect(legacyOffsetPage.items).toEqual(secondPage.items);
	});

	it('동일 occurredAt 이벤트는 eventId 내림차순 cursor로 중복 없이 이어진다', async () => {
		const firstPage = await queryService.listEvents({ limit: 1 });
		const secondPage = await queryService.listEvents({
			limit: 1,
			cursor: firstPage.nextCursor,
		});

		expect(firstPage.items.map((item) => item.eventId)).toEqual([
			'evt-resize-1',
		]);
		expect(secondPage.items.map((item) => item.eventId)).toEqual([
			'evt-failed-1',
		]);
	});

	it('잘못된 opaque event cursor를 거부한다', async () => {
		await expect(
			queryService.listEvents({ cursor: 'not-an-event-cursor' }),
		).rejects.toThrow('cursor must be a valid opaque event cursor');
	});

	it('이벤트 목록은 필터 조건을 적용한다', async () => {
		const response = await queryService.listEvents({
			eventType: 'image.cache.hit',
			sourceApp: 'cache',
			status: 'success',
			path: 'products',
			name: 'sample',
			imageKey: 'products/image/sample.png',
			requestId: 'req-cache-hit',
			limit: 10,
		});

		expect(response.items.map((item) => item.eventId)).toEqual(['evt-hit-1']);
	});

	it('이벤트 목록 search는 repository query에서 주요 문자열 필드를 검색한다', async () => {
		const response = await queryService.listEvents({
			search: 'MISSING IMAGE',
			limit: 10,
		});

		expect(response.items.map((item) => item.eventId)).toEqual([
			'evt-failed-1',
		]);
	});

	it('lifecycle 이벤트 목록은 telemetry 이벤트와 별도로 필터링한다', async () => {
		await lifecycleIngestionService.ingest({
			...baseEvent,
			eventId: 'life-upload-completed-1',
			eventType: 'image.upload.completed',
			clientServiceId: 'service-life-a',
			clientServiceSlug: 'service-life-a',
			requestId: 'req-life-completed',
			imageId: 300,
			inputBytes: 200,
			outputBytes: 150,
			durationMs: 9,
		});
		await lifecycleIngestionService.ingest({
			...baseEvent,
			eventId: 'life-upload-failed-1',
			eventType: 'image.upload.failed',
			occurredAt: '2026-07-01T00:30:00.000Z',
			clientServiceId: 'service-life-b',
			clientServiceSlug: 'service-life-b',
			requestId: 'req-life-failed',
			imageId: 301,
			name: 'broken.txt',
			imageKey: 'products/image/broken.txt',
			format: 'unknown',
			inputBytes: 9,
			status: 'failed',
			errorCode: 'BadRequestException',
			errorMessage: 'bad image',
		});

		const response = await queryService.listLifecycleEvents({
			eventType: 'image.upload.failed',
			status: 'failed',
			clientServiceSlug: 'service-life-b',
			requestId: 'req-life-failed',
			limit: 10,
		});

		expect(response.items).toEqual([
			expect.objectContaining({
				eventId: 'life-upload-failed-1',
				eventType: 'image.upload.failed',
				clientServiceSlug: 'service-life-b',
			}),
		]);
	});

	it('이미지별 lifecycle 이벤트 목록을 조회한다', async () => {
		await lifecycleIngestionService.ingest({
			...baseEvent,
			eventId: 'life-image-upload-1',
			eventType: 'image.upload.completed',
			imageId: 302,
			inputBytes: 200,
			outputBytes: 150,
			durationMs: 9,
		});
		await lifecycleIngestionService.ingest({
			...baseEvent,
			eventId: 'life-other-upload-1',
			eventType: 'image.upload.completed',
			imageId: 303,
			imageKey: 'products/image/other.png',
			name: 'other.png',
			inputBytes: 200,
			outputBytes: 150,
			durationMs: 9,
		});

		const response = await queryService.listImageLifecycleEvents(
			'products/image/sample.png',
			{ limit: 10 },
		);

		expect(response.items.map((item) => item.eventId)).toEqual([
			'life-image-upload-1',
		]);
	});

	it('리사이징 추천은 Client Service별 온디맨드 resize 사용량으로 계산한다', async () => {
		await seedResizeRecommendationEvents();

		const response = await queryService.listImageResizeRecommendations({
			minRequests: 3,
			limit: 10,
		});

		expect(response.threshold.minRequests).toBe(3);
		expect(response.items[0]).toMatchObject({
			clientServiceId: 'service-a',
			clientServiceSlug: 'catalog-api',
			width: 400,
			height: 400,
			format: 'webp',
			requestCount: 3,
			imageCount: 2,
			avgDurationMs: 20,
			p95DurationMs: 30,
			estimatedSavedResizeMs: 60,
			totalInputBytes: 3000,
			totalOutputBytes: 900,
			lastRequestedAt: '2026-07-01T03:02:00.000Z',
			recommended: true,
		});
		expect(response.items[0].sampleImageKeys).toEqual([
			'products/image/a.png',
			'products/image/b.png',
		]);
		expect(response.items).toContainEqual(
			expect.objectContaining({
				clientServiceId: 'service-b',
				width: 320,
				height: 240,
				requestCount: 1,
				recommended: false,
			}),
		);

		const filtered = await queryService.listImageResizeRecommendations({
			clientServiceSlug: 'catalog-api',
			minRequests: 4,
			limit: 10,
		});

		expect(filtered.items).toHaveLength(1);
		expect(filtered.items[0]).toMatchObject({
			clientServiceSlug: 'catalog-api',
			requestCount: 3,
			recommended: false,
		});
	});

	it('이미지 목록은 totalReads 기준으로 정렬한다', async () => {
		const response = await queryService.listImages({
			sort: 'reads',
			order: 'desc',
		});

		expect(response.items[0]).toMatchObject({
			imageKey: 'products/image/sample.png',
			totalReads: 3,
		});
	});

	it('이미지 목록은 legacy offset 입력 뒤에도 opaque cursor만 출력한다', async () => {
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-other-upload',
			eventType: 'image.upload.completed',
			occurredAt: '2026-07-01T00:20:00.000Z',
			imageId: 200,
			imageKey: 'products/image/other.png',
			name: 'other.png',
			inputBytes: 100,
			outputBytes: 80,
			durationMs: 10,
		});

		const firstPage = await queryService.listImages({ limit: 1 });
		const opaqueSecondPage = await queryService.listImages({
			limit: 1,
			cursor: firstPage.nextCursor,
		});
		const legacySecondPage = await queryService.listImages({
			limit: 1,
			cursor: '1',
		});

		expect(firstPage.nextCursor).toMatch(/^img\.v1\./);
		expect(firstPage.nextCursor).not.toMatch(/^\d+$/);
		expect(legacySecondPage.items).toEqual(opaqueSecondPage.items);
	});

	it('이미지 목록은 cacheMisses 기준으로 정렬한다', async () => {
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-other-miss-1',
			eventType: 'image.cache.miss',
			occurredAt: '2026-07-01T00:20:00.000Z',
			sourceApp: 'cache',
			imageKey: 'products/image/other.png',
			name: 'other.png',
			cacheKey: 'other',
			durationMs: 5,
		});
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-other-miss-2',
			eventType: 'image.cache.miss',
			occurredAt: '2026-07-01T00:21:00.000Z',
			sourceApp: 'cache',
			imageKey: 'products/image/other.png',
			name: 'other.png',
			cacheKey: 'other',
			durationMs: 6,
		});

		const response = await queryService.listImages({
			sort: 'cacheMisses',
			order: 'desc',
		});

		expect(response.items[0]).toMatchObject({
			imageKey: 'products/image/other.png',
			totalCacheMisses: 2,
		});
	});

	it('이미지 목록은 client service 필터를 적용한다', async () => {
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-service-a-upload',
			eventType: 'image.upload.completed',
			clientServiceId: 'service-a',
			clientServiceSlug: 'service-a',
			imageKey: 'service-a/image/a.png',
			path: 'service-a/image',
			name: 'a.png',
			inputBytes: 10,
			outputBytes: 8,
			durationMs: 7,
		});
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-service-b-upload',
			eventType: 'image.upload.completed',
			clientServiceId: 'service-b',
			clientServiceSlug: 'service-b',
			imageKey: 'service-b/image/b.png',
			path: 'service-b/image',
			name: 'b.png',
			inputBytes: 12,
			outputBytes: 9,
			durationMs: 11,
		});

		const byId = await queryService.listImages({
			clientServiceId: 'service-a',
			limit: 10,
		});
		const bySlug = await queryService.listImages({
			clientServiceSlug: 'service-b',
			limit: 10,
		});

		expect(byId.items.map((item) => item.imageKey)).toEqual([
			'service-a/image/a.png',
		]);
		expect(bySlug.items.map((item) => item.imageKey)).toEqual([
			'service-b/image/b.png',
		]);
	});

	it('DB health probe가 hang해도 readiness 응답은 deadline 안에 끝난다', async () => {
		const originalTimeout = process.env.HEALTH_PROBE_TIMEOUT_MS;
		process.env.HEALTH_PROBE_TIMEOUT_MS = '10';
		const telemetry = new InMemoryTelemetryRepository();
		const lifecycle = new InMemoryLifecycleRepository();
		jest
			.spyOn(telemetry, 'isConnected')
			.mockImplementation(() => new Promise<boolean>(() => undefined));
		const service = new AdminQueryService(
			telemetry,
			lifecycle,
			new InMemoryAdminAnalyticsRepository(telemetry),
		);

		await expect(service.getHealth()).resolves.toMatchObject({
			ok: false,
			storage: { connected: false },
		});

		if (originalTimeout === undefined)
			delete process.env.HEALTH_PROBE_TIMEOUT_MS;
		else process.env.HEALTH_PROBE_TIMEOUT_MS = originalTimeout;
		jest.restoreAllMocks();
	});

	async function seedFixture() {
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-upload-1',
			eventType: 'image.upload.completed',
			imageId: 100,
			inputBytes: 100,
			outputBytes: 80,
			durationMs: 10,
		});
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-hit-1',
			eventType: 'image.cache.hit',
			occurredAt: '2026-07-01T00:10:00.000Z',
			sourceApp: 'cache',
			requestId: 'req-cache-hit',
			cacheKey: 'sample-hit',
			durationMs: 20,
		});
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-miss-1',
			eventType: 'image.cache.miss',
			occurredAt: '2026-07-01T00:11:00.000Z',
			sourceApp: 'cache',
			cacheKey: 'sample-miss',
			durationMs: 30,
		});
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-resize-1',
			eventType: 'image.resize.completed',
			occurredAt: '2026-07-01T02:00:00.000Z',
			sourceApp: 'resize',
			width: 120,
			height: 80,
			inputBytes: 80,
			outputBytes: 40,
			durationMs: 40,
		});
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-failed-1',
			eventType: 'image.read.failed',
			occurredAt: '2026-07-01T02:00:00.000Z',
			status: 'failed',
			errorCode: 'ENOENT',
			errorMessage: 'missing image',
			durationMs: 50,
		});
	}

	async function seedResizeRecommendationEvents() {
		const common = {
			...baseEvent,
			eventType: 'image.resize.completed',
			sourceApp: 'resize',
			status: 'success',
			format: 'webp',
			width: 400,
			height: 400,
			inputBytes: 1000,
			outputBytes: 300,
			clientServiceId: 'service-a',
			clientServiceSlug: 'catalog-api',
		};

		await ingestionService.ingest({
			...common,
			eventId: 'evt-rec-a-1',
			occurredAt: '2026-07-01T03:00:00.000Z',
			imageKey: 'products/image/a.png',
			name: 'a.png',
			durationMs: 10,
		});
		await ingestionService.ingest({
			...common,
			eventId: 'evt-rec-a-2',
			occurredAt: '2026-07-01T03:01:00.000Z',
			imageKey: 'products/image/a.png',
			name: 'a.png',
			durationMs: 20,
		});
		await ingestionService.ingest({
			...common,
			eventId: 'evt-rec-a-3',
			occurredAt: '2026-07-01T03:02:00.000Z',
			imageKey: 'products/image/b.png',
			name: 'b.png',
			durationMs: 30,
		});
		await ingestionService.ingest({
			...common,
			eventId: 'evt-rec-pregenerated-skip',
			occurredAt: '2026-07-01T03:03:00.000Z',
			cacheKey: 'products/image/a.png:400x400:webp',
			durationMs: 999,
		});
		await ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-rec-b-1',
			eventType: 'image.resize.completed',
			occurredAt: '2026-07-01T03:04:00.000Z',
			sourceApp: 'resize',
			status: 'success',
			clientServiceId: 'service-b',
			clientServiceSlug: 'admin-api',
			imageKey: 'admin/image/c.png',
			path: 'admin/image',
			name: 'c.png',
			width: 320,
			height: 240,
			inputBytes: 800,
			outputBytes: 200,
			durationMs: 12,
		});
	}
});

function createImageLifecycleMetricsPrisma(): PrismaService {
	const queryRaw = jest
		.fn()
		.mockResolvedValueOnce([
			{
				pending: 2,
				ready: 10,
				deleting: 1,
				deleted: 5,
				failed: 1,
				oldestPendingAgeMs: 120_000,
				oldestDeletingAgeMs: 60_000,
			},
		])
		.mockResolvedValueOnce([
			{
				pending: 3,
				ready: 20,
				deleting: 2,
				deleted: 6,
				failed: 2,
				oldestPendingAgeMs: 90_000,
				oldestDeletingAgeMs: 45_000,
			},
		])
		.mockResolvedValueOnce([
			{
				pending: 4,
				processing: 1,
				completed: 30,
				failed: 3,
				cancelled: 2,
				oldestActiveAgeMs: 75_000,
			},
		])
		.mockResolvedValueOnce([
			{
				orphanCount: 7,
				repairedCount: 8,
				failedCount: 2,
				oldestPendingAgeMs: 120_000,
				oldestDeletingAgeMs: 60_000,
				durationMs: 25,
				lastRunAt: new Date('2026-07-11T00:00:00.000Z'),
				lastSuccessAt: new Date('2026-07-11T00:00:00.000Z'),
				lastError: null,
			},
		]);

	return {
		$queryRaw: queryRaw,
		imageLifecycleOutbox: {
			count: jest.fn().mockResolvedValue(0),
			aggregate: jest.fn().mockResolvedValue({
				_sum: { attempts: 0 },
				_min: { createdAt: null },
			}),
		},
	} as unknown as PrismaService;
}

function testRange() {
	return {
		from: '2026-07-01T00:00:00.000Z',
		to: '2026-07-01T02:59:59.999Z',
	};
}
