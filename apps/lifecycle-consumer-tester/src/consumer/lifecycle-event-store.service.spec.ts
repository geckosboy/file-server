import { ImageLifecycleEventType } from '@file/telemetry-contracts/lifecycle';
import { LifecycleEventStoreService } from './lifecycle-event-store.service';

const baseRecord = {
	receivedAt: '2026-01-01T00:00:00.000Z',
	topic: 'file.image.lifecycle.v1',
	partition: 0,
	offset: '1',
	key: 'local-demo:demo/image/sample.png:image.upload.completed',
	event: {
		schemaVersion: 1,
		eventId: 'life-evt-1',
		eventType: ImageLifecycleEventType.UploadCompleted,
		occurredAt: '2026-01-01T00:00:00.000Z',
		sourceApp: 'storage',
		environment: 'test',
		clientServiceId: 'svc-1',
		clientServiceSlug: 'local-demo',
		requestId: 'req-1',
		path: 'demo/image',
		name: 'sample.png',
		originalName: 'sample.png',
		imageKey: 'demo/image/sample.png',
		format: 'png',
		inputBytes: 100,
		outputBytes: 90,
		durationMs: 10,
		status: 'success',
	},
} as const;

describe('LifecycleEventStoreService', () => {
	it('수신 이벤트를 최신순으로 저장하고 필터링한다', () => {
		const store = new LifecycleEventStoreService();
		store.add(baseRecord);
		store.add({
			...baseRecord,
			offset: '2',
			event: {
				...baseRecord.event,
				eventId: 'life-evt-2',
				clientServiceSlug: 'other-demo',
			},
		});

		expect(store.count()).toBe(2);
		expect(store.list({ clientServiceSlug: 'local-demo' })).toEqual([
			expect.objectContaining({
				event: expect.objectContaining({ eventId: 'life-evt-1' }),
			}),
		]);
		expect(store.list({ limit: 1 })[0].event.eventId).toBe('life-evt-2');
	});

	it('저장된 이벤트를 초기화한다', () => {
		const store = new LifecycleEventStoreService();
		store.add(baseRecord);

		expect(store.clear()).toBe(1);
		expect(store.list()).toEqual([]);
	});
});
