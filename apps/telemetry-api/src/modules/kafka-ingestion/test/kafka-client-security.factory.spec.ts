import { Kafka } from 'kafkajs';
import { KafkaJsTelemetryKafkaConsumerFactory } from '../kafka-ingestion.consumer-factory';
import { KafkaJsLifecycleKafkaConsumerFactory } from '../../kafka-lifecycle/kafka-lifecycle.consumer-factory';

jest.mock('kafkajs', () => ({
	Kafka: jest.fn(),
	logLevel: { WARN: 4 },
}));

const KafkaConstructor = Kafka as unknown as jest.Mock;

describe('telemetry-api Kafka factory security wiring', () => {
	const originalEnvironment = {
		KAFKA_SASL_MECHANISM: process.env.KAFKA_SASL_MECHANISM,
		KAFKA_SASL_USERNAME: process.env.KAFKA_SASL_USERNAME,
		KAFKA_SASL_PASSWORD: process.env.KAFKA_SASL_PASSWORD,
	};
	const consumer = { connect: jest.fn() };
	const producer = { connect: jest.fn() };
	const consumerFactory = jest.fn(() => consumer);
	const producerFactory = jest.fn(() => producer);

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.KAFKA_SASL_MECHANISM = 'scram-sha-256';
		process.env.KAFKA_SASL_USERNAME = 'telemetry-api';
		process.env.KAFKA_SASL_PASSWORD = 'secret';
		KafkaConstructor.mockImplementation(() => ({
			consumer: consumerFactory,
			producer: producerFactory,
		}));
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(originalEnvironment)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it.each([
		[
			'telemetry',
			new KafkaJsTelemetryKafkaConsumerFactory(),
			{
				enabled: true,
				brokers: ['kafka:9093'],
				clientId: 'telemetry-api',
				groupId: 'telemetry-group',
				topic: 'file.image.events.v1',
				dlqTopic: 'file.image.events.v1.dlq',
				fromBeginning: false,
				retryMaxAttempts: 3,
				retryBackoffMs: 100,
			},
		],
		[
			'lifecycle',
			new KafkaJsLifecycleKafkaConsumerFactory(),
			{
				enabled: true,
				brokers: ['kafka:9093'],
				clientId: 'telemetry-api-lifecycle',
				groupId: 'lifecycle-group',
				topic: 'file.image.lifecycle.v1',
				dlqTopic: 'file.image.lifecycle.v1.dlq',
				fromBeginning: false,
				retryMaxAttempts: 3,
				retryBackoffMs: 100,
			},
		],
	])(
		'%s consumer와 DLQ producer에 같은 SASL 설정을 적용한다',
		(_name, factory, config) => {
			factory.create(config);
			factory.createDlqProducer(config);

			expect(KafkaConstructor).toHaveBeenCalledTimes(2);
			for (const [kafkaConfig] of KafkaConstructor.mock.calls) {
				expect(kafkaConfig).toEqual(
					expect.objectContaining({
						brokers: ['kafka:9093'],
						sasl: {
							mechanism: 'scram-sha-256',
							username: 'telemetry-api',
							password: 'secret',
						},
					}),
				);
			}
			expect(producerFactory).toHaveBeenCalledWith({
				allowAutoTopicCreation: false,
			});
		},
	);
});
