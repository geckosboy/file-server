import { Logger } from '@nestjs/common';
import { EachMessagePayload } from 'kafkajs';
import { LifecycleConsumerService } from '.././lifecycle-consumer.service';
import { LifecycleConsumerStatusService } from '.././lifecycle-consumer-status.service';
import { LifecycleEventStoreService } from '.././lifecycle-event-store.service';
import { LifecycleKafkaConsumerFactory } from '.././lifecycle-consumer.factory';

const validEvent = {
	schemaVersion: 1,
	eventId: 'life-evt-1',
	eventType: 'image.upload.completed',
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
};

const createService = () => {
	process.env.NODE_ENV = 'test';
	process.env.CLIENT_SERVICE_SLUG = 'local-demo';
	const store = new LifecycleEventStoreService();
	const status = new LifecycleConsumerStatusService();
	const factory: LifecycleKafkaConsumerFactory = {
		create: jest.fn(),
	};
	const service = new LifecycleConsumerService(store, status, factory);
	return { service, status, store };
};

const createMessagePayload = (value: unknown): EachMessagePayload => ({
	topic: 'file.image.lifecycle.v1',
	partition: 0,
	message: {
		offset: '1',
		timestamp: '2026-01-01T00:00:00.000Z',
		attributes: 0,
		key: Buffer.from('local-demo:demo/image/sample.png:image.upload.completed'),
		value: Buffer.from(JSON.stringify(value)),
		size: 0,
	},
	heartbeat: jest.fn(),
	pause: jest.fn(() => jest.fn()),
});

describe('LifecycleConsumerService', () => {
	let logSpy: jest.SpyInstance;
	let warnSpy: jest.SpyInstance;

	beforeEach(() => {
		logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
		warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
	});

	afterEach(() => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		delete process.env.CLIENT_SERVICE_SLUG;
	});

	it('유효한 lifecycle 이벤트를 검증해서 메모리에 저장한다', async () => {
		const { service, status, store } = createService();

		await service.handleMessage(createMessagePayload(validEvent));

		expect(store.list()).toHaveLength(1);
		expect(store.list()[0]).toMatchObject({
			key: 'local-demo:demo/image/sample.png:image.upload.completed',
			event: { eventId: 'life-evt-1', clientServiceSlug: 'local-demo' },
		});
		expect(status.getStatus()).toMatchObject({
			receivedEventCount: 1,
			storedEventCount: 1,
			invalidMessageCount: 0,
		});
	});

	it('필터와 맞지 않는 이벤트는 저장하지 않고 skipped로 기록한다', async () => {
		const { service, status, store } = createService();

		await service.handleMessage(
			createMessagePayload({ ...validEvent, clientServiceSlug: 'other-demo' }),
		);

		expect(store.list()).toHaveLength(0);
		expect(status.getStatus()).toMatchObject({
			receivedEventCount: 1,
			skippedEventCount: 1,
			storedEventCount: 0,
		});
	});

	it('잘못된 payload는 invalid로 기록한다', async () => {
		const { service, status, store } = createService();

		await service.handleMessage(createMessagePayload({ eventType: 'unknown' }));

		expect(store.list()).toHaveLength(0);
		expect(status.getStatus()).toMatchObject({
			receivedEventCount: 1,
			invalidMessageCount: 1,
		});
	});
});
