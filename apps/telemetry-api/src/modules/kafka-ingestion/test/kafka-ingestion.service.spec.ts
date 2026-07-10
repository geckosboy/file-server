import { EachMessagePayload } from 'kafkajs';
import { IngestionService } from '../../ingestion/ingestion.service';
import { InMemoryTelemetryRepository } from '../../telemetry/telemetry.repository';
import { ImageTelemetryEvent } from '../../telemetry/telemetry.types';
import { readTelemetryKafkaConsumerConfig } from '.././kafka-ingestion.config';
import {
	TelemetryKafkaConsumer,
	TelemetryKafkaConsumerFactory,
	TelemetryKafkaDlqProducer,
} from '.././kafka-ingestion.consumer-factory';
import { TelemetryKafkaConsumerService } from '.././kafka-ingestion.service';
import { parseKafkaMessageValue } from '../../kafka/kafka-message.parser';
import { TelemetryKafkaConsumerStatusService } from '.././kafka-ingestion.status';
import { KafkaLagProbe } from '../../kafka/kafka-consumer-lag';

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

const createKafkaMessagePayload = (
	value: Buffer,
	options: { offset?: string; partition?: number } = {},
): EachMessagePayload => ({
	topic: 'file.image.events.v1',
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

type TestConsumerEvent = {
	id: number;
	type: string;
	timestamp: number;
	payload: Record<string, unknown>;
};

type TestConsumerEventListener = (event: TestConsumerEvent) => void;

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
			dlqTopic: 'file.image.events.v1.dlq',
			fromBeginning: false,
			retryMaxAttempts: 3,
			retryBackoffMs: 100,
			connectRetryBackoffMs: 500,
			connectRetryMaxBackoffMs: 10_000,
			lagRefreshIntervalMs: 5_000,
		});
	});

	it('DLQ topic과 retry 상한을 환경 변수로 재정의한다', () => {
		expect(
			readTelemetryKafkaConsumerConfig({
				NODE_ENV: 'test',
				TELEMETRY_KAFKA_CONSUMER_ENABLED: 'true',
				TELEMETRY_KAFKA_BROKERS: 'localhost:9094',
				TELEMETRY_KAFKA_DLQ_TOPIC: 'file.telemetry.poison.v1',
				TELEMETRY_KAFKA_RETRY_MAX_ATTEMPTS: '5',
				TELEMETRY_KAFKA_RETRY_BACKOFF_MS: '25',
				TELEMETRY_KAFKA_CONNECT_RETRY_BACKOFF_MS: '20',
				TELEMETRY_KAFKA_CONNECT_RETRY_MAX_BACKOFF_MS: '200',
				TELEMETRY_KAFKA_LAG_REFRESH_INTERVAL_MS: '250',
			}),
		).toMatchObject({
			dlqTopic: 'file.telemetry.poison.v1',
			retryMaxAttempts: 5,
			retryBackoffMs: 25,
			connectRetryBackoffMs: 20,
			connectRetryMaxBackoffMs: 200,
			lagRefreshIntervalMs: 250,
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
	let dlqProducer: jest.Mocked<TelemetryKafkaDlqProducer>;
	let lagProbe: jest.Mocked<KafkaLagProbe>;
	let factory: jest.Mocked<TelemetryKafkaConsumerFactory>;
	let service: TelemetryKafkaConsumerService;
	let originalEnv: NodeJS.ProcessEnv;
	let emitConsumerEvent: (
		eventName: string,
		payload: Record<string, unknown>,
	) => void;

	beforeEach(() => {
		originalEnv = { ...process.env };
		repository = new InMemoryTelemetryRepository();
		ingestionService = new IngestionService(repository);
		statusService = new TelemetryKafkaConsumerStatusService();
		const eventListeners = new Map<string, Set<TestConsumerEventListener>>();
		emitConsumerEvent = (eventName, payload) => {
			for (const listener of eventListeners.get(eventName) ?? []) {
				listener({
					id: 1,
					type: eventName,
					timestamp: Date.now(),
					payload,
				});
			}
		};
		const events = {
			CRASH: 'consumer.crash',
			REBALANCING: 'consumer.rebalancing',
			STOP: 'consumer.stop',
			DISCONNECT: 'consumer.disconnect',
			GROUP_JOIN: 'consumer.group_join',
		} as unknown as TelemetryKafkaConsumer['events'];
		consumer = {
			commitOffsets: jest.fn().mockResolvedValue(undefined),
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			events,
			on: jest.fn((eventName: string, listener: TestConsumerEventListener) => {
				const listeners = eventListeners.get(eventName) ?? new Set();
				listeners.add(listener);
				eventListeners.set(eventName, listeners);
				return () => listeners.delete(listener);
			}),
			run: jest.fn().mockImplementation(async () => {
				emitConsumerEvent(events.GROUP_JOIN, {
					groupId: 'file-telemetry-api',
				});
			}),
			subscribe: jest.fn().mockResolvedValue(undefined),
		} as unknown as jest.Mocked<TelemetryKafkaConsumer>;
		dlqProducer = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			send: jest.fn().mockResolvedValue([]),
		};
		lagProbe = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			fetchTopicOffsets: jest
				.fn()
				.mockResolvedValue([
					{ partition: 0, offset: '3', high: '3', low: '0' },
				]),
			fetchOffsets: jest.fn().mockResolvedValue([
				{
					topic: 'file.image.events.v1',
					partitions: [{ partition: 0, offset: '1', metadata: null }],
				},
			]),
		};
		factory = {
			create: jest.fn().mockReturnValue(consumer),
			createDlqProducer: jest.fn().mockReturnValue(dlqProducer),
			createLagProbe: jest.fn().mockReturnValue(lagProbe),
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
		await enableConsumer(service);
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
		expect(consumer.commitOffsets).toHaveBeenCalledWith([
			{ topic: 'file.image.events.v1', partition: 0, offset: '2' },
		]);
		expect(statusService.getHealth().lastConsumedAt).toEqual(
			expect.any(String),
		);
	});

	it('transient 저장 실패를 bounded retry하고 성공 후에만 offset을 commit한다', async () => {
		const payload = createKafkaMessagePayload(
			Buffer.from(JSON.stringify(uploadEvent)),
			{ offset: '9' },
		);
		jest
			.spyOn(ingestionService, 'ingest')
			.mockResolvedValueOnce({
				accepted: false,
				inserted: false,
				eventId: uploadEvent.eventId,
				reason: 'insert_failed',
			})
			.mockResolvedValueOnce({
				accepted: true,
				inserted: true,
				eventId: uploadEvent.eventId,
			});
		process.env.TELEMETRY_KAFKA_RETRY_BACKOFF_MS = '0';
		await enableConsumer(service);

		await service.handleMessage(payload);

		expect(ingestionService.ingest).toHaveBeenCalledTimes(2);
		expect(payload.heartbeat).toHaveBeenCalledTimes(1);
		expect(consumer.commitOffsets).toHaveBeenCalledWith([
			{ topic: 'file.image.events.v1', partition: 0, offset: '10' },
		]);
		expect(dlqProducer.send).not.toHaveBeenCalled();
	});

	it('retry 상한을 넘은 transient 실패는 offset을 commit하지 않고 다시 throw한다', async () => {
		jest.spyOn(ingestionService, 'ingest').mockResolvedValue({
			accepted: false,
			inserted: false,
			eventId: uploadEvent.eventId,
			reason: 'insert_failed',
		});
		process.env.TELEMETRY_KAFKA_RETRY_MAX_ATTEMPTS = '2';
		process.env.TELEMETRY_KAFKA_RETRY_BACKOFF_MS = '0';
		await enableConsumer(service);

		await expect(
			service.handleMessage(
				createKafkaMessagePayload(Buffer.from(JSON.stringify(uploadEvent))),
			),
		).rejects.toThrow('insert_failed');

		expect(ingestionService.ingest).toHaveBeenCalledTimes(2);
		expect(consumer.commitOffsets).not.toHaveBeenCalled();
		expect(dlqProducer.send).not.toHaveBeenCalled();
		expect(statusService.getHealth().lastConsumedAt).toBeNull();
	});

	it('재시작/리밸런싱으로 미커밋 message가 재전달되면 같은 event를 복구한다', async () => {
		const payload = createKafkaMessagePayload(
			Buffer.from(JSON.stringify(uploadEvent)),
			{ offset: '30' },
		);
		jest
			.spyOn(ingestionService, 'ingest')
			.mockResolvedValueOnce({
				accepted: false,
				inserted: false,
				eventId: uploadEvent.eventId,
				reason: 'insert_failed',
			})
			.mockResolvedValueOnce({
				accepted: true,
				inserted: true,
				eventId: uploadEvent.eventId,
			});
		process.env.TELEMETRY_KAFKA_RETRY_MAX_ATTEMPTS = '1';
		await enableConsumer(service);

		await expect(service.handleMessage(payload)).rejects.toThrow(
			'insert_failed',
		);
		expect(consumer.commitOffsets).not.toHaveBeenCalled();

		await service.handleMessage(payload);

		expect(ingestionService.ingest).toHaveBeenCalledTimes(2);
		expect(consumer.commitOffsets).toHaveBeenCalledWith([
			{ topic: 'file.image.events.v1', partition: 0, offset: '31' },
		]);
	});

	it('poison payload를 원문/오류/partition/offset envelope로 DLQ 후 commit한다', async () => {
		const raw = Buffer.from('{broken');
		await enableConsumer(service);

		await service.handleMessage(
			createKafkaMessagePayload(raw, { offset: '17', partition: 2 }),
		);

		expect(dlqProducer.send).toHaveBeenCalledWith({
			topic: 'file.image.events.v1.dlq',
			acks: -1,
			messages: [
				{
					key: 'file.image.events.v1:2:17',
					value: expect.any(String),
				},
			],
		});
		const record = dlqProducer.send.mock.calls[0][0];
		expect(JSON.parse(String(record.messages[0].value))).toMatchObject({
			schemaVersion: 1,
			sourceTopic: 'file.image.events.v1',
			partition: 2,
			offset: '17',
			rawPayload: raw.toString('base64'),
			rawPayloadEncoding: 'base64',
			error: 'Kafka message value must be valid JSON',
		});
		expect(consumer.commitOffsets).toHaveBeenCalledWith([
			{ topic: 'file.image.events.v1', partition: 2, offset: '18' },
		]);
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
			autoCommit: false,
			eachMessage: expect.any(Function),
		});
		expect(dlqProducer.connect).toHaveBeenCalledTimes(1);
		expect(statusService.getHealth()).toMatchObject({
			enabled: true,
			connected: true,
			brokerConnected: true,
			ready: true,
			consumerLag: 2,
		});
	});

	it('최초 연결 실패 후 capped backoff로 다시 연결한다', async () => {
		jest.useFakeTimers();
		process.env.NODE_ENV = 'development';
		process.env.KAFKA_CLIENT_BROKERS = 'localhost:9094';
		process.env.TELEMETRY_KAFKA_CONNECT_RETRY_BACKOFF_MS = '10';
		process.env.TELEMETRY_KAFKA_CONNECT_RETRY_MAX_BACKOFF_MS = '10';
		consumer.connect
			.mockRejectedValueOnce(new Error('broker unavailable'))
			.mockResolvedValue(undefined);

		await service.onApplicationBootstrap();

		expect(statusService.getHealth()).toMatchObject({
			connected: false,
			ready: false,
			reconnectAttempts: 1,
			lastError: 'broker unavailable',
		});

		await jest.advanceTimersByTimeAsync(10);

		expect(consumer.connect).toHaveBeenCalledTimes(2);
		expect(statusService.getHealth()).toMatchObject({
			connected: true,
			ready: true,
			reconnectAttempts: 0,
		});
		await service.onApplicationShutdown();
		jest.useRealTimers();
	});

	it('consumer crash/rebalance/stop/disconnect 동안 ready=false이고 group join 후에만 복구한다', async () => {
		await enableConsumer(service);
		const expectInactiveUntilGroupJoin = (eventName: string) => {
			emitConsumerEvent(eventName, {});
			expect(statusService.getHealth()).toMatchObject({
				connected: false,
				ready: false,
			});
			emitConsumerEvent(consumer.events.GROUP_JOIN, {
				groupId: 'file-telemetry-api',
			});
			expect(statusService.getHealth()).toMatchObject({
				connected: true,
				ready: true,
			});
		};

		expectInactiveUntilGroupJoin(consumer.events.STOP);
		expectInactiveUntilGroupJoin(consumer.events.DISCONNECT);

		emitConsumerEvent(consumer.events.REBALANCING, {
			groupId: 'file-telemetry-api',
			memberId: 'member-1',
		});
		expect(statusService.getHealth()).toMatchObject({
			connected: false,
			ready: false,
		});

		emitConsumerEvent(consumer.events.GROUP_JOIN, {
			groupId: 'file-telemetry-api',
		});
		expect(statusService.getHealth()).toMatchObject({
			connected: true,
			ready: true,
		});

		emitConsumerEvent(consumer.events.CRASH, {
			error: new Error('consumer crashed'),
			groupId: 'file-telemetry-api',
			restart: true,
		});
		expect(statusService.getHealth()).toMatchObject({
			connected: false,
			ready: false,
			lastError: 'consumer crashed',
		});

		emitConsumerEvent(consumer.events.GROUP_JOIN, {
			groupId: 'file-telemetry-api',
		});
		expect(statusService.getHealth()).toMatchObject({
			connected: true,
			ready: true,
			lastError: null,
		});
	});

	it('종료 시 consumer 연결을 끊는다', async () => {
		process.env.NODE_ENV = 'development';
		process.env.KAFKA_CLIENT_BROKERS = 'localhost:9094';
		await service.onApplicationBootstrap();

		await service.onApplicationShutdown();

		expect(consumer.disconnect).toHaveBeenCalledTimes(1);
		expect(dlqProducer.disconnect).toHaveBeenCalledTimes(1);
		expect(lagProbe.disconnect).toHaveBeenCalledTimes(1);
		expect(statusService.getHealth().connected).toBe(false);
		emitConsumerEvent(consumer.events.GROUP_JOIN, {
			groupId: 'file-telemetry-api',
		});
		expect(statusService.getHealth().connected).toBe(false);
	});
});

async function enableConsumer(service: TelemetryKafkaConsumerService) {
	process.env.NODE_ENV = 'development';
	process.env.KAFKA_CLIENT_BROKERS = 'localhost:9094';
	await service.onApplicationBootstrap();
}
