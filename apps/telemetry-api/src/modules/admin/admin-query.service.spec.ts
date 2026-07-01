import { AdminQueryService } from './admin-query.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { InMemoryTelemetryRepository } from '../telemetry/telemetry.repository';

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
	let ingestionService: IngestionService;
	let queryService: AdminQueryService;

	beforeEach(() => {
		const repository = new InMemoryTelemetryRepository();
		ingestionService = new IngestionService(repository);
		queryService = new AdminQueryService(repository);
		seedFixture();
	});

	it('대시보드 요약에서 캐시 hit율을 계산한다', () => {
		const summary = queryService.getSummary(testRange());

		expect(summary.cacheHitRate).toBe(0.5);
		expect(summary.cacheMissRate).toBe(0.5);
	});

	it('캐시 이벤트가 없으면 hit율을 null로 반환한다', () => {
		const summary = queryService.getSummary({
			from: '2026-07-01T02:00:00.000Z',
			to: '2026-07-01T02:59:59.999Z',
		});

		expect(summary.cacheHitRate).toBeNull();
		expect(summary.cacheMissRate).toBeNull();
	});

	it('실패율을 전체 이벤트 대비 실패 이벤트 비율로 계산한다', () => {
		const summary = queryService.getSummary(testRange());

		expect(summary.totalEvents).toBe(5);
		expect(summary.failureRate).toBe(0.2);
	});

	it('평균 처리 시간은 durationMs가 있는 이벤트만 기준으로 계산한다', () => {
		const summary = queryService.getSummary(testRange());

		expect(summary.avgDurationMs).toBe(30);
	});

	it('처리 시간 p95를 fixture 기준으로 계산한다', () => {
		const summary = queryService.getSummary(testRange());

		expect(summary.p95DurationMs).toBe(50);
	});

	it('시간대별 집계는 비어 있는 bucket을 0으로 채운다', () => {
		const timeseries = queryService.getTimeseries({
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

	it('이벤트 목록은 occurredAt 내림차순으로 페이지네이션한다', () => {
		const firstPage = queryService.listEvents({ limit: 2 });
		const secondPage = queryService.listEvents({
			limit: 2,
			cursor: firstPage.nextCursor,
		});

		expect(firstPage.items.map((item) => item.eventId)).toEqual([
			'evt-resize-1',
			'evt-failed-1',
		]);
		expect(firstPage.nextCursor).toBe('2');
		expect(secondPage.items.map((item) => item.eventId)).toEqual([
			'evt-miss-1',
			'evt-hit-1',
		]);
	});

	it('이벤트 목록은 필터 조건을 적용한다', () => {
		const response = queryService.listEvents({
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

	it('이미지 목록은 totalReads 기준으로 정렬한다', () => {
		const response = queryService.listImages({ sort: 'reads', order: 'desc' });

		expect(response.items[0]).toMatchObject({
			imageKey: 'products/image/sample.png',
			totalReads: 3,
		});
	});

	it('이미지 목록은 cacheMisses 기준으로 정렬한다', () => {
		ingestionService.ingest({
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
		ingestionService.ingest({
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

		const response = queryService.listImages({
			sort: 'cacheMisses',
			order: 'desc',
		});

		expect(response.items[0]).toMatchObject({
			imageKey: 'products/image/other.png',
			totalCacheMisses: 2,
		});
	});

	function seedFixture() {
		ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-upload-1',
			eventType: 'image.upload.completed',
			imageId: 100,
			inputBytes: 100,
			outputBytes: 80,
			durationMs: 10,
		});
		ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-hit-1',
			eventType: 'image.cache.hit',
			occurredAt: '2026-07-01T00:10:00.000Z',
			sourceApp: 'cache',
			requestId: 'req-cache-hit',
			cacheKey: 'sample-hit',
			durationMs: 20,
		});
		ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-miss-1',
			eventType: 'image.cache.miss',
			occurredAt: '2026-07-01T00:11:00.000Z',
			sourceApp: 'cache',
			cacheKey: 'sample-miss',
			durationMs: 30,
		});
		ingestionService.ingest({
			...baseEvent,
			eventId: 'evt-resize-1',
			eventType: 'image.resize.completed',
			occurredAt: '2026-07-01T02:00:00.000Z',
			sourceApp: 'resize',
			width: 120,
			height: 80,
			outputBytes: 40,
			durationMs: 40,
		});
		ingestionService.ingest({
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
});

function testRange() {
	return {
		from: '2026-07-01T00:00:00.000Z',
		to: '2026-07-01T02:59:59.999Z',
	};
}
