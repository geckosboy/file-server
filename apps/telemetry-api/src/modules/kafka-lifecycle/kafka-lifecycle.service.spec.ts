import { EachMessagePayload } from 'kafkajs';
import { ImageLifecycleEvent } from '../lifecycle/lifecycle.types';
import { InMemoryLifecycleRepository } from '../lifecycle/lifecycle.repository';
import { LifecycleIngestionService } from '../lifecycle/lifecycle-ingestion.service';
import { readLifecycleKafkaConsumerConfig } from './kafka-lifecycle.config';
import {
	LifecycleKafkaConsumer,
	LifecycleKafkaConsumerFactory,
} from './kafka-lifecycle.consumer-factory';
import { LifecycleKafkaConsumerService } from './kafka-lifecycle.service';
import { LifecycleKafkaConsumerStatusService } from './kafka-lifecycle.status';

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

const createKafkaMessagePayload = (value: Buffer): EachMessagePayload => ({
	topic: 'file.image.lifecycle.v1',
	partition: 0,
	message: {
		attributes: 0,
		headers: {},
		offset: '1',
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
			fromBeginning: false,
		});
	});
});

describe('Kafka lifecycle consumer 서비스', () => {
	let repository: InMemoryLifecycleRepository;
	let ingestionService: LifecycleIngestionService;
	let statusService: LifecycleKafkaConsumerStatusService;
	let consumer: jest.Mocked<LifecycleKafkaConsumer>;
	let factory: jest.Mocked<LifecycleKafkaConsumerFactory>;
	let service: LifecycleKafkaConsumerService;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		repository = new InMemoryLifecycleRepository();
		ingestionService = new LifecycleIngestionService(repository);
		statusService = new LifecycleKafkaConsumerStatusService();
		consumer = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			run: jest.fn().mockResolvedValue(undefined),
			subscribe: jest.fn().mockResolvedValue(undefined),
		};
		factory = {
			create: jest.fn().mockReturnValue(consumer),
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
		expect(statusService.getHealth().lastConsumedAt).toEqual(
			expect.any(String),
		);
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
			eachMessage: expect.any(Function),
		});
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
		expect(statusService.getHealth().connected).toBe(false);
	});
});
