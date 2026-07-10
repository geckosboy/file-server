import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
	IMAGE_TELEMETRY_EVENT_EXAMPLES,
	IMAGE_TELEMETRY_EVENT_RULES,
	IMAGE_TELEMETRY_EVENT_TYPES,
	IMAGE_TELEMETRY_KAFKA_SEND_OPTIONS,
	ImageTelemetryEventType,
	ImageTelemetrySourceApp,
	ImageTelemetryStage,
	createImageTelemetryAsyncApiDocument,
	deliverImageTelemetryEvent,
	getImageTelemetryDeliveryFailureCount,
	getImageTelemetryProducerStatus,
	resetImageTelemetryDeliveryFailureCount,
	validateImageTelemetryEvent,
} from '../events';

describe('이미지 텔레메트리 생산자 계약 conformance', () => {
	it('생산 가능한 모든 이벤트 fixture를 같은 runtime validator로 검증한다', () => {
		expect(Object.keys(IMAGE_TELEMETRY_EVENT_EXAMPLES).sort()).toEqual(
			[...IMAGE_TELEMETRY_EVENT_TYPES].sort(),
		);

		for (const eventType of IMAGE_TELEMETRY_EVENT_TYPES) {
			const fixture = IMAGE_TELEMETRY_EVENT_EXAMPLES[eventType];
			const result = validateImageTelemetryEvent(fixture);

			expect(result).toEqual({ ok: true, event: fixture });
			expect(IMAGE_TELEMETRY_EVENT_RULES[eventType].sourceApps).toContain(
				fixture.sourceApp,
			);
			expect(fixture.status).toBe(
				IMAGE_TELEMETRY_EVENT_RULES[eventType].status,
			);
		}
	});

	it('cache origin read 실패와 기존 storage read 실패를 모두 v1으로 허용한다', () => {
		const cacheFailure =
			IMAGE_TELEMETRY_EVENT_EXAMPLES[ImageTelemetryEventType.ReadFailed];
		expect(cacheFailure).toMatchObject({
			sourceApp: ImageTelemetrySourceApp.Cache,
			stage: ImageTelemetryStage.CacheOriginFetch,
		});
		expect(validateImageTelemetryEvent(cacheFailure).ok).toBe(true);

		const legacyStorageFailure = {
			...cacheFailure,
			eventId: 'legacy-storage-read-failed',
			sourceApp: ImageTelemetrySourceApp.Storage,
			stage: undefined,
			cacheKey: undefined,
		};
		expect(validateImageTelemetryEvent(legacyStorageFailure).ok).toBe(true);
	});

	it('producer delivery는 all acknowledgements를 명시한다', () => {
		expect(IMAGE_TELEMETRY_KAFKA_SEND_OPTIONS.acks).toBe(-1);
	});

	it('delivery 실패를 business 오류로 던지지 않고 counter로 관찰한다', async () => {
		resetImageTelemetryDeliveryFailureCount();
		const onFailure = jest.fn();
		const event =
			IMAGE_TELEMETRY_EVENT_EXAMPLES[ImageTelemetryEventType.CacheHit];

		await expect(
			deliverImageTelemetryEvent({
				event,
				deliver: async () => {
					throw new Error('broker unavailable');
				},
				onFailure,
			}),
		).resolves.toEqual({
			status: 'failed',
			failureCount: 1,
			errorMessage: 'broker unavailable',
		});
		expect(getImageTelemetryDeliveryFailureCount()).toBe(1);
		expect(getImageTelemetryProducerStatus()).toEqual({
			topic: 'file.image.events.v1',
			acknowledgements: 'all',
			maxRetries: 5,
			deliveryFailureCount: 1,
		});
		expect(onFailure).toHaveBeenCalledWith({
			errorMessage: 'broker unavailable',
			failureCount: 1,
		});
	});

	it('생성된 telemetry AsyncAPI가 runtime contract와 byte-for-byte 일치한다', () => {
		const asyncApiPath = resolve(
			__dirname,
			'../../../../docs/asyncapi/file-image-telemetry.asyncapi.json',
		);
		const document = JSON.parse(readFileSync(asyncApiPath, 'utf8')) as unknown;

		expect(document).toEqual(createImageTelemetryAsyncApiDocument());
	});
});
