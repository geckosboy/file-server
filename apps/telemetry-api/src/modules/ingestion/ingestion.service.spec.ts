import { InMemoryTelemetryRepository } from '../telemetry/telemetry.repository';
import { IngestionService } from './ingestion.service';

const uploadCompleted = {
	schemaVersion: 1,
	eventId: 'evt-upload-1',
	eventType: 'image.upload.completed',
	occurredAt: '2026-07-01T00:00:00.000Z',
	sourceApp: 'storage',
	environment: 'test',
	path: 'products/image',
	name: 'sample.00000000-0000-4000-8000-000000000000.png',
	originalName: 'sample.png',
	imageKey: 'products/image/sample.00000000-0000-4000-8000-000000000000.png',
	format: 'png',
	inputBytes: 1024,
	outputBytes: 800,
	durationMs: 12.5,
	status: 'success',
};

describe('텔레메트리 수집 서비스', () => {
	let repository: InMemoryTelemetryRepository;
	let service: IngestionService;

	beforeEach(() => {
		repository = new InMemoryTelemetryRepository();
		service = new IngestionService(repository);
	});

	it('신규 이미지 이벤트를 원본 이벤트 테이블에 저장한다', async () => {
		const result = await service.ingest(
			uploadCompleted,
			new Date('2026-07-01T00:00:01.000Z'),
		);
		const events = await repository.listEvents();

		expect(result).toEqual({
			accepted: true,
			inserted: true,
			eventId: 'evt-upload-1',
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			eventId: 'evt-upload-1',
			receivedAt: '2026-07-01T00:00:01.000Z',
		});
	});

	it('같은 eventId가 다시 들어오면 중복 저장하지 않는다', async () => {
		await service.ingest(uploadCompleted);
		const duplicate = await service.ingest({
			...uploadCompleted,
			durationMs: 99,
		});
		const events = await repository.listEvents();

		expect(duplicate).toEqual({
			accepted: true,
			inserted: false,
			eventId: 'evt-upload-1',
		});
		expect(events).toHaveLength(1);
		expect(events[0].durationMs).toBe(12.5);
	});

	it('잘못된 이벤트는 저장하지 않고 validation 실패 카운트를 증가시킨다', async () => {
		const invalidEvents = [
			{ ...uploadCompleted, schemaVersion: 2 },
			{ ...uploadCompleted, eventId: '' },
			{ ...uploadCompleted, eventType: 'image.unknown' },
			{ ...uploadCompleted, occurredAt: 'not-date' },
			{ ...uploadCompleted, status: 'failed', errorCode: undefined },
		];

		for (const invalidEvent of invalidEvents) {
			const result = await service.ingest(invalidEvent);
			expect(result.accepted).toBe(false);
		}

		expect(await repository.listEvents()).toHaveLength(0);
		expect((await repository.getMetrics()).validationFailureCount).toBe(5);
	});

	it('기존 앱이 발행하는 표준 이벤트 종류를 모두 수집한다', async () => {
		const appEvents = [
			{
				...uploadCompleted,
				eventId: 'evt-read-completed-1',
				eventType: 'image.read.completed',
			},
			{
				...uploadCompleted,
				eventId: 'evt-resize-requested-1',
				eventType: 'image.resize.requested',
				sourceApp: 'resize',
			},
			{
				...uploadCompleted,
				eventId: 'evt-cache-stored-1',
				eventType: 'image.cache.stored',
				sourceApp: 'cache',
				cacheKey: 'products/image/sample.png:w128',
			},
		];

		for (const event of appEvents) {
			const result = await service.ingest(event);
			expect(result.accepted).toBe(true);
		}

		expect(
			(await repository.listEvents()).map((event) => event.eventType),
		).toEqual([
			'image.read.completed',
			'image.resize.requested',
			'image.cache.stored',
		]);
	});

	it('레거시 업로드 결과 payload를 업로드 완료 이벤트로 변환한다', async () => {
		const result = await service.ingestLegacyUploadResult(
			{
				id: 77,
				format: 'png',
				size: 4096,
				exeTime: 21,
				path: 'legacy/path',
				name: 'legacy.png',
			},
			new Date('2026-07-01T01:00:00.000Z'),
		);
		const events = await repository.listEvents();

		expect(result.accepted).toBe(true);
		expect(events[0]).toMatchObject({
			eventId: 'legacy-upload-77',
			eventType: 'image.upload.completed',
			imageId: 77,
			imageKey: 'legacy/path/legacy.png',
			outputBytes: 4096,
			durationMs: 21,
		});
	});

	it('업로드 완료 이벤트가 들어오면 image_assets 요약을 갱신한다', async () => {
		await service.ingest(uploadCompleted);

		expect(await repository.listAssets()).toEqual([
			expect.objectContaining({
				imageKey: uploadCompleted.imageKey,
				originalName: 'sample.png',
				totalEvents: 1,
				lastUploadedAt: '2026-07-01T00:00:00.000Z',
				originalBytes: 1024,
				storedBytes: 800,
			}),
		]);
	});

	it('캐시 hit 이벤트가 들어오면 image_assets의 total_cache_hits를 증가시킨다', async () => {
		await service.ingest({
			...uploadCompleted,
			eventId: 'evt-cache-hit-1',
			eventType: 'image.cache.hit',
			sourceApp: 'cache',
			cacheKey:
				'products/image/sample.00000000-0000-4000-8000-000000000000.png:w128',
		});

		expect((await repository.listAssets())[0]).toMatchObject({
			totalReads: 1,
			totalCacheHits: 1,
			totalCacheMisses: 0,
		});
	});

	it('캐시 miss 이벤트가 들어오면 image_assets의 total_cache_misses를 증가시킨다', async () => {
		await service.ingest({
			...uploadCompleted,
			eventId: 'evt-cache-miss-1',
			eventType: 'image.cache.miss',
			sourceApp: 'cache',
			cacheKey:
				'products/image/sample.00000000-0000-4000-8000-000000000000.png:w128',
		});

		expect((await repository.listAssets())[0]).toMatchObject({
			totalReads: 1,
			totalCacheHits: 0,
			totalCacheMisses: 1,
		});
	});

	it('리사이즈 완료 이벤트가 들어오면 image_variants를 갱신한다', async () => {
		await service.ingest({
			...uploadCompleted,
			eventId: 'evt-resize-1',
			eventType: 'image.resize.completed',
			sourceApp: 'resize',
			width: 120,
			height: 80,
			outputBytes: 320,
			durationMs: 30,
		});

		expect((await repository.listAssets())[0].totalResizes).toBe(1);
		expect(await repository.listVariants()).toEqual([
			expect.objectContaining({
				variantKey:
					'products/image/sample.00000000-0000-4000-8000-000000000000.png:120x80:png',
				resizeCount: 1,
				avgDurationMs: 30,
				p95DurationMs: 30,
			}),
		]);
	});

	it('실패 이벤트가 들어오면 total_failures를 증가시킨다', async () => {
		await service.ingest({
			...uploadCompleted,
			eventId: 'evt-read-failed-1',
			eventType: 'image.read.failed',
			status: 'failed',
			errorCode: 'ENOENT',
			errorMessage: 'not found',
		});

		expect((await repository.listAssets())[0]).toMatchObject({
			totalReads: 1,
			totalFailures: 1,
		});
	});
});
