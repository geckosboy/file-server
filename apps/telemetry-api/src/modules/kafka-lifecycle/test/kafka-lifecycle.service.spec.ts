import { EachMessagePayload } from 'kafkajs';
import { ImageLifecycleEvent } from '../../lifecycle/lifecycle.types';
import { InMemoryLifecycleRepository } from '../../lifecycle/lifecycle.repository';
import { LifecycleIngestionService } from '../../lifecycle/lifecycle-ingestion.service';
import { readLifecycleKafkaConsumerConfig } from '.././kafka-lifecycle.config';
import {
	LifecycleKafkaConsumer,
	LifecycleKafkaConsumerFactory,
	LifecycleKafkaDlqProducer,
} from '.././kafka-lifecycle.consumer-factory';
import { LifecycleKafkaConsumerService } from '.././kafka-lifecycle.service';
import { LifecycleKafkaConsumerStatusService } from '.././kafka-lifecycle.status';

const lifecycleEvent: ImageLifecycleEvent = {
	schemaVersion: 1,
	eventId: 'life-kafka-upload-1',
	eventType: 'image.upload.completed',
	occurredAt: '2026-07-01T00:00:00.000Z',
	receivedAt: '2026-07-01T00:00:01.000Z',
	sourceApp: 'storage',
	environment: 'test',
	clientServiceId: 'service-1',
	clientServiceSlug: 'catalog-api',
	requestId: 'req-life-kafka-1',
	imageId: 100,
	path: 'products/image',
	name: 'sample.png',
	imageKey: 'products/image/sample.png',
	format: 'png',
	inputBytes: 1024,
	outputBytes: 800,
	durationMs: 12.5,
	status: 'success',
	rawPayload: {},
};

const createKafkaMessagePayload = (
	value: Buffer,
	options: { offset?: string; partition?: number } = {},
): EachMessagePayload => ({
	topic: 'file.image.lifecycle.v1',
	partition: options.partition ?? 0,
	message: {
		attributes: 0,
		headers: {},
		offset: options.offset ?? '1',
		timestamp: '1783041507162',
		key: Buffer.from('key'),
		value,
	},
	heartbeat: jest.fn().mockResolvedValue(undefined),
	pause: jest.fn().mockReturnValue(jest.fn()),
});

describe('Kafka lifecycle consumer 설정', () => {
	it('test 환경에서는 명시적으로 켜지 않으면 비활성화한다', () => {
		expect(
			readLifecycleKafkaConsumerConfig({
				NODE_ENV: 'test',
				KAFKA_CLIENT_BROKERS: 'localhost:9094',
			}),
		).toMatchObject({
			enabled: false,
			brokers: ['localhost:9094'],
		});
	});

	it('broker와 명시 enabled가 있으면 lifecycle topic/group 기본값을 구성한다', () => {
		expect(
			readLifecycleKafkaConsumerConfig({
				NODE_ENV: 'test',
				LIFECYCLE_KAFKA_CONSUMER_ENABLED: 'true',
				LIFECYCLE_KAFKA_BROKERS: 'localhost:9094, localhost:9095',
			}),
		).toMatchObject({
			enabled: true,
			brokers: ['localhost:9094', 'localhost:9095'],
			clientId: 'telemetry-api-lifecycle',
			groupId: 'file-telemetry-api-lifecycle',
			topic: 'file.image.lifecycle.v1',
			dlqTopic: 'file.image.lifecycle.v1.dlq',
			fromBeginning: false,
			retryMaxAttempts: 3,
			retryBackoffMs: 100,
		});
	});
});

describe('Kafka lifecycle consumer 서비스', () => {
	let repository: InMemoryLifecycleRepository;
	let ingestionService: LifecycleIngestionService;
	let statusService: LifecycleKafkaConsumerStatusService;
	let consumer: jest.Mocked<LifecycleKafkaConsumer>;
	let dlqProducer: jest.Mocked<LifecycleKafkaDlqProducer>;
	let factory: jest.Mocked<LifecycleKafkaConsumerFactory>;
	let service: LifecycleKafkaConsumerService;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		repository = new InMemoryLifecycleRepository();
		ingestionService = new LifecycleIngestionService(repository);
		statusService = new LifecycleKafkaConsumerStatusService();
		consumer = {
			commitOffsets: jest.fn().mockResolvedValue(undefined),
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			run: jest.fn().mockResolvedValue(undefined),
			subscribe: jest.fn().mockResolvedValue(undefined),
		};
		dlqProducer = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			send: jest.fn().mockResolvedValue([]),
		};
		factory = {
			create: jest.fn().mockReturnValue(consumer),
			createDlqProducer: jest.fn().mockReturnValue(dlqProducer),
		};
		service = new LifecycleKafkaConsumerService(
			ingestionService,
			statusService,
			factory,
		);
	});

	afterEach(() => {
		process.env = originalEnv;
		jest.restoreAllMocks();
	});

	it('Kafka lifecycle message를 lifecycle 저장소로 저장한다', async () => {
		await enableConsumer(service);
		await service.handleMessage(
			createKafkaMessagePayload(Buffer.from(JSON.stringify(lifecycleEvent))),
		);

		expect(await repository.listEvents()).toEqual([
			expect.objectContaining({
				eventId: 'life-kafka-upload-1',
				clientServiceId: 'service-1',
				clientServiceSlug: 'catalog-api',
				requestId: 'req-life-kafka-1',
			}),
		]);
		expect(consumer.commitOffsets).toHaveBeenCalledWith([
			{ topic: 'file.image.lifecycle.v1', partition: 0, offset: '2' },
		]);
		expect(statusService.getHealth().lastConsumedAt).toEqual(
			expect.any(String),
		);
	});

	it('lifecycle transient 저장 실패는 bounded retry 후 성공 offset만 commit한다', async () => {
		const payload = createKafkaMessagePayload(
			Buffer.from(JSON.stringify(lifecycleEvent)),
			{ offset: '9' },
		);
		jest
			.spyOn(ingestionService, 'ingest')
			.mockResolvedValueOnce({
				accepted: false,
				inserted: false,
				eventId: lifecycleEvent.eventId,
				reason: 'insert_failed',
			})
			.mockResolvedValueOnce({
				accepted: true,
				inserted: false,
				eventId: lifecycleEvent.eventId,
			});
		process.env.LIFECYCLE_KAFKA_RETRY_BACKOFF_MS = '0';
		await enableConsumer(service);

		await service.handleMessage(payload);

		expect(ingestionService.ingest).toHaveBeenCalledTimes(2);
		expect(payload.heartbeat).toHaveBeenCalledTimes(1);
		expect(consumer.commitOffsets).toHaveBeenCalledWith([
			{ topic: 'file.image.lifecycle.v1', partition: 0, offset: '10' },
		]);
	});

	it('중복 lifecycle eventId는 멱등 저장 후 각 전달 offset을 commit한다', async () => {
		const payload = createKafkaMessagePayload(
			Buffer.from(JSON.stringify(lifecycleEvent)),
		);
		await enableConsumer(service);

		await service.handleMessage(payload);
		await service.handleMessage(payload);

		expect(await repository.listEvents()).toHaveLength(1);
		expect(consumer.commitOffsets).toHaveBeenCalledTimes(2);
	});

	it('lifecycle poison payload를 DLQ envelope로 저장한 뒤 offset을 commit한다', async () => {
		const raw = Buffer.from('{broken');
		await enableConsumer(service);

		await service.handleMessage(
			createKafkaMessagePayload(raw, { offset: '21', partition: 3 }),
		);

		const record = dlqProducer.send.mock.calls[0][0];
		expect(record).toMatchObject({
			topic: 'file.image.lifecycle.v1.dlq',
			acks: -1,
		});
		expect(JSON.parse(String(record.messages[0].value))).toMatchObject({
			sourceTopic: 'file.image.lifecycle.v1',
			partition: 3,
			offset: '21',
			rawPayload: raw.toString('base64'),
			error: 'Kafka message value must be valid JSON',
		});
		expect(consumer.commitOffsets).toHaveBeenCalledWith([
			{ topic: 'file.image.lifecycle.v1', partition: 3, offset: '22' },
		]);
	});

	it('깨진 JSON message는 lifecycle 검증 실패 metric으로 기록한다', async () => {
		const result = await service.ingestMessageValue(Buffer.from('{broken'));

		expect(result).toEqual({
			accepted: false,
			inserted: false,
			reason: 'Kafka message value must be valid JSON',
		});
		expect(await repository.listEvents()).toHaveLength(0);
		expect((await repository.getMetrics()).validationFailureCount).toBe(1);
	});

	it('활성화된 설정이면 lifecycle topic을 subscribe한다', async () => {
		process.env.NODE_ENV = 'development';
		process.env.KAFKA_CLIENT_BROKERS = 'localhost:9094';

		await service.onApplicationBootstrap();

		expect(factory.create).toHaveBeenCalledWith(
			expect.objectContaining({
				brokers: ['localhost:9094'],
				groupId: 'file-telemetry-api-lifecycle',
				topic: 'file.image.lifecycle.v1',
			}),
		);
		expect(consumer.connect).toHaveBeenCalledTimes(1);
		expect(consumer.subscribe).toHaveBeenCalledWith({
			fromBeginning: false,
			topic: 'file.image.lifecycle.v1',
		});
		expect(consumer.run).toHaveBeenCalledWith({
			autoCommit: false,
			eachMessage: expect.any(Function),
		});
		expect(dlqProducer.connect).toHaveBeenCalledTimes(1);
		expect(statusService.getHealth()).toMatchObject({
			enabled: true,
			connected: true,
		});
	});

	it('종료 시 lifecycle consumer 연결을 끊는다', async () => {
		process.env.NODE_ENV = 'development';
		process.env.KAFKA_CLIENT_BROKERS = 'localhost:9094';
		await service.onApplicationBootstrap();

		await service.onApplicationShutdown();

		expect(consumer.disconnect).toHaveBeenCalledTimes(1);
		expect(dlqProducer.disconnect).toHaveBeenCalledTimes(1);
		expect(statusService.getHealth().connected).toBe(false);
	});
});

async function enableConsumer(service: LifecycleKafkaConsumerService) {
	process.env.NODE_ENV = 'development';
	process.env.KAFKA_CLIENT_BROKERS = 'localhost:9094';
	await service.onApplicationBootstrap();
}
