import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEnvironment,
	ImageTelemetryEventType,
	ImageTelemetrySourceApp,
	ImageTelemetryStatus,
	createImageKey,
	createTelemetryKafkaKey,
	validateImageTelemetryEvent,
} from '.././events';

const baseEvent = {
	schemaVersion: 1,
	eventId: 'evt-1',
	occurredAt: '2026-01-01T00:00:00.000Z',
	sourceApp: ImageTelemetrySourceApp.Storage,
	environment: ImageTelemetryEnvironment.Test,
	path: '/products/images/',
	name: 'sample.png',
	originalName: 'sample-original.png',
	imageKey: 'products/images/sample.png',
	status: ImageTelemetryStatus.Success,
};

describe('이미지 텔레메트리 이벤트 계약', () => {
	it('이미지 업로드 완료 이벤트를 표준 스키마로 검증한다', () => {
		const result = validateImageTelemetryEvent({
			...baseEvent,
			eventType: ImageTelemetryEventType.UploadCompleted,
			inputBytes: 1000,
			outputBytes: 980,
			durationMs: 12,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(result.errors.join(', '));
		}
		expect(IMAGE_TELEMETRY_TOPIC).toBe('file.image.events.v1');
		expect(createTelemetryKafkaKey(result.event)).toBe(
			'products/images/sample.png:image.upload.completed',
		);
		expect(result.event.originalName).toBe('sample-original.png');
	});

	it('이미지 리사이즈 완료 이벤트에서 크기와 바이트 정보를 검증한다', () => {
		const result = validateImageTelemetryEvent({
			...baseEvent,
			eventId: 'evt-resize-1',
			eventType: ImageTelemetryEventType.ResizeCompleted,
			sourceApp: ImageTelemetrySourceApp.Resize,
			width: 320,
			height: 240,
			inputBytes: 1000,
			outputBytes: 500,
			durationMs: 33,
		});

		expect(result.ok).toBe(true);
	});

	it('캐시 hit 이벤트에는 cacheKey가 필요하다', () => {
		const result = validateImageTelemetryEvent({
			...baseEvent,
			eventId: 'evt-cache-hit-1',
			eventType: ImageTelemetryEventType.CacheHit,
			sourceApp: ImageTelemetrySourceApp.Cache,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error('검증이 실패해야 합니다');
		}
		expect(result.errors).toContain('캐시 이벤트에는 cacheKey가 필요합니다');
	});

	it('실패 이벤트에는 errorCode와 errorMessage가 필요하다', () => {
		const result = validateImageTelemetryEvent({
			...baseEvent,
			eventId: 'evt-failed-1',
			eventType: ImageTelemetryEventType.ResizeFailed,
			sourceApp: ImageTelemetrySourceApp.Resize,
			status: ImageTelemetryStatus.Failed,
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

	it('지원하지 않는 schemaVersion은 거부한다', () => {
		const result = validateImageTelemetryEvent({
			...baseEvent,
			schemaVersion: 2,
			eventType: ImageTelemetryEventType.UploadCompleted,
			imageId: 10,
			inputBytes: 1000,
			outputBytes: 980,
			durationMs: 12,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error('검증이 실패해야 합니다');
		}
		expect(result.errors).toContain('schemaVersion은 1이어야 합니다');
	});

	it('지원하지 않는 eventType은 거부한다', () => {
		const result = validateImageTelemetryEvent({
			...baseEvent,
			eventType: 'image.unknown',
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error('검증이 실패해야 합니다');
		}
		expect(result.errors).toContain('지원하지 않는 eventType입니다');
	});

	it('이미지 키가 없으면 경로와 이름으로 표준 이미지 키를 만든다', () => {
		const result = validateImageTelemetryEvent({
			...baseEvent,
			eventId: 'evt-key-1',
			eventType: ImageTelemetryEventType.ReadCompleted,
			imageKey: undefined,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(result.errors.join(', '));
		}
		expect(result.event.imageKey).toBe('products/images/sample.png');
		expect(createImageKey('/products/images/', 'sample.png')).toBe(
			'products/images/sample.png',
		);
	});

	it('처리 시간과 바이트 값은 0 이상이어야 한다', () => {
		const result = validateImageTelemetryEvent({
			...baseEvent,
			eventType: ImageTelemetryEventType.UploadCompleted,
			imageId: 10,
			inputBytes: -1,
			outputBytes: 980,
			durationMs: -3,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error('검증이 실패해야 합니다');
		}
		expect(result.errors).toEqual(
			expect.arrayContaining([
				'inputBytes는 0 이상의 숫자여야 합니다',
				'durationMs는 0 이상의 숫자여야 합니다',
				'업로드 완료 이벤트에는 inputBytes가 필요합니다',
				'업로드 완료 이벤트에는 durationMs가 필요합니다',
			]),
		);
	});

	it('너비와 높이는 기존 이미지 계약처럼 1부터 4096 사이여야 한다', () => {
		const result = validateImageTelemetryEvent({
			...baseEvent,
			eventId: 'evt-resize-invalid',
			eventType: ImageTelemetryEventType.ResizeCompleted,
			sourceApp: ImageTelemetrySourceApp.Resize,
			width: 4097,
			height: 0,
			inputBytes: 1000,
			outputBytes: 500,
			durationMs: 33,
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error('검증이 실패해야 합니다');
		}
		expect(result.errors).toEqual(
			expect.arrayContaining([
				'width는 1부터 4096 사이의 정수여야 합니다',
				'height는 1부터 4096 사이의 정수여야 합니다',
			]),
		);
	});
});
