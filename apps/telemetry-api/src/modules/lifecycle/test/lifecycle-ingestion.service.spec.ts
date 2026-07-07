import { ImageLifecycleEventType } from '@file/telemetry-contracts/lifecycle';
import { InMemoryLifecycleRepository } from '.././lifecycle.repository';
import { LifecycleIngestionService } from '.././lifecycle-ingestion.service';

const uploadCompleted = {
	schemaVersion: 1,
	eventId: 'life-upload-1',
	eventType: 'image.upload.completed',
	occurredAt: '2026-07-01T00:00:00.000Z',
	sourceApp: 'storage',
	environment: 'test',
	clientServiceId: 'service-1',
	clientServiceSlug: 'catalog-api',
	requestId: 'req-life-1',
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

const uploadFailed = {
	schemaVersion: 1,
	eventId: 'life-upload-failed-1',
	eventType: 'image.upload.failed',
	occurredAt: '2026-07-01T00:01:00.000Z',
	sourceApp: 'storage',
	environment: 'test',
	clientServiceId: 'service-1',
	clientServiceSlug: 'catalog-api',
	requestId: 'req-life-failed-1',
	path: 'products/image',
	name: 'broken.txt',
	originalName: 'broken.txt',
	imageKey: 'products/image/broken.txt',
	format: 'unknown',
	inputBytes: 9,
	status: 'failed',
	errorCode: 'BadRequestException',
	errorMessage: '알 수 없는 MIME type 입니다.',
};

describe('이미지 lifecycle 수집 서비스', () => {
	let repository: InMemoryLifecycleRepository;
	let service: LifecycleIngestionService;

	beforeEach(() => {
		repository = new InMemoryLifecycleRepository();
		service = new LifecycleIngestionService(repository);
	});

	it('업로드 완료 lifecycle 이벤트를 별도 저장소에 저장한다', async () => {
		const result = await service.ingest(
			uploadCompleted,
			new Date('2026-07-01T00:00:01.000Z'),
		);
		const events = await repository.listEvents();

		expect(result).toEqual({
			accepted: true,
			inserted: true,
			eventId: 'life-upload-1',
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			eventId: 'life-upload-1',
			eventType: ImageLifecycleEventType.UploadCompleted,
			receivedAt: '2026-07-01T00:00:01.000Z',
			clientServiceSlug: 'catalog-api',
			originalName: 'sample.png',
			rawPayload: uploadCompleted,
		});
	});

	it('업로드 실패 lifecycle 이벤트를 저장한다', async () => {
		const result = await service.ingest(uploadFailed);
		const [event] = await repository.listEvents();

		expect(result.accepted).toBe(true);
		expect(event).toMatchObject({
			eventType: ImageLifecycleEventType.UploadFailed,
			status: 'failed',
			originalName: 'broken.txt',
			errorCode: 'BadRequestException',
			errorMessage: '알 수 없는 MIME type 입니다.',
		});
	});

	it('같은 eventId는 중복 저장하지 않는다', async () => {
		await service.ingest(uploadCompleted);
		const duplicate = await service.ingest({
			...uploadCompleted,
			durationMs: 99,
		});

		expect(duplicate).toEqual({
			accepted: true,
			inserted: false,
			eventId: 'life-upload-1',
		});
		expect(await repository.listEvents()).toHaveLength(1);
	});

	it('잘못된 lifecycle payload는 검증 실패 metric으로 기록한다', async () => {
		const invalidEvents = [
			{ ...uploadCompleted, schemaVersion: 2 },
			{ ...uploadCompleted, eventId: '' },
			{ ...uploadCompleted, eventType: 'image.cache.hit' },
			{ ...uploadFailed, errorCode: undefined },
		];

		for (const invalidEvent of invalidEvents) {
			const result = await service.ingest(invalidEvent);
			expect(result.accepted).toBe(false);
		}

		expect(await repository.listEvents()).toHaveLength(0);
		expect((await repository.getMetrics()).validationFailureCount).toBe(4);
	});
});
