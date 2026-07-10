import {
	Inject,
	Injectable,
	Logger,
	OnApplicationBootstrap,
	OnApplicationShutdown,
} from '@nestjs/common';
import { EachMessagePayload } from 'kafkajs';
import {
	IngestionResult,
	IngestionService,
} from '../ingestion/ingestion.service';
import { readTelemetryKafkaConsumerConfig } from './kafka-ingestion.config';
import {
	TELEMETRY_KAFKA_CONSUMER_FACTORY,
	TelemetryKafkaConsumer,
	TelemetryKafkaConsumerFactory,
	TelemetryKafkaDlqProducer,
} from './kafka-ingestion.consumer-factory';
import { TelemetryKafkaConsumerStatusService } from './kafka-ingestion.status';
import { parseKafkaMessageValue } from '../kafka/kafka-message.parser';
import { processKafkaMessageWithResilience } from '../kafka/kafka-consumer-resilience';

@Injectable()
export class TelemetryKafkaConsumerService
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	private readonly logger = new Logger(TelemetryKafkaConsumerService.name);
	private consumer?: TelemetryKafkaConsumer;
	private dlqProducer?: TelemetryKafkaDlqProducer;
	private config?: ReturnType<typeof readTelemetryKafkaConsumerConfig>;

	constructor(
		private readonly ingestionService: IngestionService,
		private readonly statusService: TelemetryKafkaConsumerStatusService,
		@Inject(TELEMETRY_KAFKA_CONSUMER_FACTORY)
		private readonly consumerFactory: TelemetryKafkaConsumerFactory,
	) {}

	async onApplicationBootstrap() {
		const config = readTelemetryKafkaConsumerConfig();
		this.config = config;
		this.statusService.configure(config);
		if (!config.enabled) {
			this.logger.log(
				`Kafka telemetry consumer disabled: ${config.disabledReason}`,
			);
			return;
		}

		try {
			this.consumer = this.consumerFactory.create(config);
			this.dlqProducer = this.consumerFactory.createDlqProducer(config);
			await this.consumer.connect();
			await this.dlqProducer.connect();
			await this.consumer.subscribe({
				topic: config.topic,
				fromBeginning: config.fromBeginning,
			});
			await this.consumer.run({
				autoCommit: false,
				eachMessage: (payload) => this.handleMessage(payload),
			});
			this.statusService.markConnected();
			this.logger.log(
				`Kafka telemetry consumer connected: ${config.topic} group=${config.groupId}`,
			);
		} catch (error) {
			await this.disconnectClients();
			this.statusService.markDisconnected(error);
			this.logger.error(
				`Kafka telemetry consumer 연결 실패: ${errorToMessage(error)}`,
			);
		}
	}

	async onApplicationShutdown() {
		try {
			await this.disconnectClients();
		} finally {
			this.statusService.markDisconnected();
		}
	}

	async handleMessage(payload: EachMessagePayload): Promise<void> {
		const consumer = this.requireConsumer();
		const dlqProducer = this.requireDlqProducer();
		const config = this.requireConfig();
		const processing = await processKafkaMessageWithResilience({
			payload,
			retryPolicy: config,
			ingest: (value) => this.ingestMessageValue(value),
			publishDeadLetter: async (envelope) => {
				await dlqProducer.send({
					topic: config.dlqTopic,
					acks: -1,
					messages: [
						{
							key: `${payload.topic}:${payload.partition}:${payload.message.offset}`,
							value: JSON.stringify(envelope),
						},
					],
				});
			},
			commitOffset: async (offset) => {
				await consumer.commitOffsets([
					{ topic: payload.topic, partition: payload.partition, offset },
				]);
			},
		});
		this.statusService.markConsumed();
		if (processing.outcome === 'dead-lettered') {
			this.logger.warn(
				`Kafka telemetry event DLQ 처리: ${processing.ingestion.reason ?? 'unknown reason'}`,
			);
		}
	}

	async ingestMessageValue(value: unknown): Promise<IngestionResult> {
		const parsed = parseKafkaMessageValue(value);
		if (!parsed.ok) {
			return this.ingestionService.rejectInvalidPayload(parsed.reason);
		}

		return this.ingestionService.ingest(parsed.payload);
	}

	private requireConsumer(): TelemetryKafkaConsumer {
		if (!this.consumer) {
			throw new Error('Kafka telemetry consumer is not initialized');
		}
		return this.consumer;
	}

	private requireDlqProducer(): TelemetryKafkaDlqProducer {
		if (!this.dlqProducer) {
			throw new Error('Kafka telemetry DLQ producer is not initialized');
		}
		return this.dlqProducer;
	}

	private requireConfig(): ReturnType<typeof readTelemetryKafkaConsumerConfig> {
		if (!this.config) {
			throw new Error('Kafka telemetry consumer config is not initialized');
		}
		return this.config;
	}

	private async disconnectClients(): Promise<void> {
		await Promise.allSettled([
			this.consumer?.disconnect(),
			this.dlqProducer?.disconnect(),
		]);
	}
}

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
