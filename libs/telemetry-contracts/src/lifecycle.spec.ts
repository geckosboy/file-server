import {
	IMAGE_LIFECYCLE_TOPIC,
	ImageLifecycleEnvironment,
	ImageLifecycleEventType,
	ImageLifecycleSourceApp,
	ImageLifecycleStatus,
	createLifecycleImageKey,
	createLifecycleKafkaKey,
	validateImageLifecycleEvent,
} from './lifecycle';

const baseEvent = {
	schemaVersion: 1,
	eventId: 'life-evt-1',
	occurredAt: '2026-01-01T00:00:00.000Z',
	sourceApp: ImageLifecycleSourceApp.Storage,
	environment: ImageLifecycleEnvironment.Test,
	clientServiceId: 'svc-1',
	clientServiceSlug: 'catalog-api',
	requestId: 'req-1',
	path: '/products/images/',
	name: 'sample.png',
	imageKey: 'products/images/sample.png',
	status: ImageLifecycleStatus.Success,
};

describe('이미지 lifecycle 이벤트 계약', () => {
	it('클라이언트 서비스 소비용 topic 이름을 고정한다', () => {
		expect(IMAGE_LIFECYCLE_TOPIC).toBe('file.image.lifecycle.v1');
	});

	it('업로드 완료 lifecycle 이벤트를 표준 스키마로 검증한다', () => {
		const result = validateImageLifecycleEvent({
			...baseEvent,
			eventType: ImageLifecycleEventType.UploadCompleted,
			imageId: 10,
			format: 'png',
			inputBytes: 1000,
			outputBytes: 980,
			durationMs: 12,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(result.errors.join(', '));
		}
		expect(createLifecycleKafkaKey(result.event)).toBe(
			'catalog-api:products/images/sample.png:image.upload.completed',
		);
	});

	it('업로드 실패 lifecycle 이벤트에는 실패 정보가 필요하다', () => {
		const result = validateImageLifecycleEvent({
			...baseEvent,
			eventId: 'life-evt-failed',
			eventType: ImageLifecycleEventType.UploadFailed,
			status: ImageLifecycleStatus.Failed,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error('검증이 실패해야 합니다');
		}
		expect(result.errors).toEqual(
			expect.arrayContaining([
				'실패 이벤트에는 errorCode가 필요합니다',
				'실패 이벤트에는 errorMessage가 필요합니다',
			]),
		);
	});

	it('이미지 키가 없으면 경로와 이름으로 표준 이미지 키를 만든다', () => {
		const result = validateImageLifecycleEvent({
			...baseEvent,
			eventId: 'life-evt-key',
			eventType: ImageLifecycleEventType.UploadCompleted,
			imageKey: undefined,
			imageId: 10,
			inputBytes: 1000,
			outputBytes: 980,
			durationMs: 12,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(result.errors.join(', '));
		}
		expect(result.event.imageKey).toBe('products/images/sample.png');
		expect(createLifecycleImageKey('/products/images/', 'sample.png')).toBe(
			'products/images/sample.png',
		);
	});
});
