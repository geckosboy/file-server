import { EachMessagePayload } from 'kafkajs';
import { IngestionService } from '../ingestion/ingestion.service';
import { InMemoryTelemetryRepository } from '../telemetry/telemetry.repository';
import { ImageTelemetryEvent } from '../telemetry/telemetry.types';
import { readTelemetryKafkaConsumerConfig } from './kafka-ingestion.config';
import {
	TelemetryKafkaConsumer,
	TelemetryKafkaConsumerFactory,
} from './kafka-ingestion.consumer-factory';
import { TelemetryKafkaConsumerService } from './kafka-ingestion.service';
import { parseKafkaMessageValue } from '../kafka/kafka-message.parser';
import { TelemetryKafkaConsumerStatusService } from './kafka-ingestion.status';

const uploadEvent: ImageTelemetryEvent = {
	schemaVersion: 1,
	eventId: 'evt-kafka-upload-1',
	eventType: 'image.upload.completed',
	occurredAt: '2026-07-01T00:00:00.000Z',
	receivedAt: '2026-07-01T00:00:01.000Z',
	sourceApp: 'storage',
	environment: 'test',
	clientServiceId: 'service-1',
	clientServiceSlug: 'local-demo',
	requestId: 'req-kafka-1',
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
	topic: 'file.image.events.v1',
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

describe('Kafka 텔레메트리 consumer 설정', () => {
	it('test 환경에서는 명시적으로 켜지 않으면 비활성화한다', () => {
		expect(
			readTelemetryKafkaConsumerConfig({
				NODE_ENV: 'test',
				KAFKA_CLIENT_BROKERS: 'localhost:9094',
			}),
		).toMatchObject({
			enabled: false,
			brokers: ['localhost:9094'],
		});
	});

	it('broker와 명시 enabled가 있으면 topic/group 기본값을 구성한다', () => {
		expect(
			readTelemetryKafkaConsumerConfig({
				NODE_ENV: 'test',
				TELEMETRY_KAFKA_CONSUMER_ENABLED: 'true',
				TELEMETRY_KAFKA_BROKERS: 'localhost:9094, localhost:9095',
			}),
		).toMatchObject({
			enabled: true,
			brokers: ['localhost:9094', 'localhost:9095'],
			clientId: 'telemetry-api',
			groupId: 'file-telemetry-api',
			topic: 'file.image.events.v1',
			fromBeginning: false,
		});
	});
});

describe('Kafka 텔레메트리 payload 파서', () => {
	it('Buffer JSON payload를 표준 이벤트 객체로 파싱한다', () => {
		const result = parseKafkaMessageValue(
			Buffer.from(JSON.stringify(uploadEvent)),
		);

		expect(result).toEqual({ ok: true, payload: uploadEvent });
	});

	it('Nest Kafka message 형태의 value 중첩 JSON도 펼친다', () => {
		const result = parseKafkaMessageValue(
			JSON.stringify({
				key: 'products/image/sample.png:image.upload.completed',
				value: JSON.stringify(uploadEvent),
			}),
		);

		expect(result).toEqual({ ok: true, payload: uploadEvent });
	});

	it('빈 값과 깨진 JSON은 거부한다', () => {
		expect(parseKafkaMessageValue(null)).toEqual({
			ok: false,
			reason: 'Kafka message value is empty',
		});
		expect(parseKafkaMessageValue('{broken')).toEqual({
			ok: false,
			reason: 'Kafka message value must be valid JSON',
		});
	});
});

describe('Kafka 텔레메트리 consumer 서비스', () => {
	let repository: InMemoryTelemetryRepository;
	let ingestionService: IngestionService;
	let statusService: TelemetryKafkaConsumerStatusService;
	let consumer: jest.Mocked<TelemetryKafkaConsumer>;
	let factory: jest.Mocked<TelemetryKafkaConsumerFactory>;
	let service: TelemetryKafkaConsumerService;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		repository = new InMemoryTelemetryRepository();
		ingestionService = new IngestionService(repository);
		statusService = new TelemetryKafkaConsumerStatusService();
		consumer = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			run: jest.fn().mockResolvedValue(undefined),
			subscribe: jest.fn().mockResolvedValue(undefined),
		};
		factory = {
			create: jest.fn().mockReturnValue(consumer),
		};
		service = new TelemetryKafkaConsumerService(
			ingestionService,
			statusService,
			factory,
		);
	});

	afterEach(() => {
		process.env = originalEnv;
		jest.restoreAllMocks();
	});

	it('Kafka message를 기존 IngestionService로 저장한다', async () => {
		await service.handleMessage(
			createKafkaMessagePayload(Buffer.from(JSON.stringify(uploadEvent))),
		);

		expect(await repository.listEvents()).toEqual([
			expect.objectContaining({
				eventId: 'evt-kafka-upload-1',
				clientServiceId: 'service-1',
				clientServiceSlug: 'local-demo',
				requestId: 'req-kafka-1',
			}),
		]);
		expect(statusService.getHealth().lastConsumedAt).toEqual(
			expect.any(String),
		);
	});

	it('깨진 JSON message는 검증 실패 metric으로 기록한다', async () => {
		const result = await service.ingestMessageValue(Buffer.from('{broken'));

		expect(result).toEqual({
			accepted: false,
			inserted: false,
			reason: 'Kafka message value must be valid JSON',
		});
		expect(await repository.listEvents()).toHaveLength(0);
		expect((await repository.getMetrics()).validationFailureCount).toBe(1);
	});

	it('활성화된 설정이면 consumer를 연결하고 topic을 subscribe한다', async () => {
		process.env.NODE_ENV = 'development';
		process.env.KAFKA_CLIENT_BROKERS = 'localhost:9094';

		await service.onApplicationBootstrap();

		expect(factory.create).toHaveBeenCalledWith(
			expect.objectContaining({
				brokers: ['localhost:9094'],
				groupId: 'file-telemetry-api',
				topic: 'file.image.events.v1',
			}),
		);
		expect(consumer.connect).toHaveBeenCalledTimes(1);
		expect(consumer.subscribe).toHaveBeenCalledWith({
			fromBeginning: false,
			topic: 'file.image.events.v1',
		});
		expect(consumer.run).toHaveBeenCalledWith({
			eachMessage: expect.any(Function),
		});
		expect(statusService.getHealth()).toMatchObject({
			enabled: true,
			connected: true,
		});
	});

	it('종료 시 consumer 연결을 끊는다', async () => {
		process.env.NODE_ENV = 'development';
		process.env.KAFKA_CLIENT_BROKERS = 'localhost:9094';
		await service.onApplicationBootstrap();

		await service.onApplicationShutdown();

		expect(consumer.disconnect).toHaveBeenCalledTimes(1);
		expect(statusService.getHealth().connected).toBe(false);
	});
});
