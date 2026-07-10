import {
	Inject,
	Injectable,
	Logger,
	OnApplicationBootstrap,
	OnApplicationShutdown,
} from '@nestjs/common';
import { EachMessagePayload } from 'kafkajs';
import { IngestionResult } from '../ingestion/ingestion.service';
import { LifecycleIngestionService } from '../lifecycle/lifecycle-ingestion.service';
import { parseKafkaMessageValue } from '../kafka/kafka-message.parser';
import { readLifecycleKafkaConsumerConfig } from './kafka-lifecycle.config';
import {
	LIFECYCLE_KAFKA_CONSUMER_FACTORY,
	LifecycleKafkaConsumer,
	LifecycleKafkaConsumerFactory,
	LifecycleKafkaDlqProducer,
} from './kafka-lifecycle.consumer-factory';
import { LifecycleKafkaConsumerStatusService } from './kafka-lifecycle.status';
import { processKafkaMessageWithResilience } from '../kafka/kafka-consumer-resilience';

@Injectable()
export class LifecycleKafkaConsumerService
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	private readonly logger = new Logger(LifecycleKafkaConsumerService.name);
	private consumer?: LifecycleKafkaConsumer;
	private dlqProducer?: LifecycleKafkaDlqProducer;
	private config?: ReturnType<typeof readLifecycleKafkaConsumerConfig>;

	constructor(
		private readonly ingestionService: LifecycleIngestionService,
		private readonly statusService: LifecycleKafkaConsumerStatusService,
		@Inject(LIFECYCLE_KAFKA_CONSUMER_FACTORY)
		private readonly consumerFactory: LifecycleKafkaConsumerFactory,
	) {}

	async onApplicationBootstrap() {
		const config = readLifecycleKafkaConsumerConfig();
		this.config = config;
		this.statusService.configure(config);
		if (!config.enabled) {
			this.logger.log(
				`Kafka lifecycle consumer disabled: ${config.disabledReason}`,
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
				`Kafka lifecycle consumer connected: ${config.topic} group=${config.groupId}`,
			);
		} catch (error) {
			await this.disconnectClients();
			this.statusService.markDisconnected(error);
			this.logger.error(
				`Kafka lifecycle consumer 연결 실패: ${errorToMessage(error)}`,
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
				`Kafka lifecycle event DLQ 처리: ${processing.ingestion.reason ?? 'unknown reason'}`,
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

	private requireConsumer(): LifecycleKafkaConsumer {
		if (!this.consumer) {
			throw new Error('Kafka lifecycle consumer is not initialized');
		}
		return this.consumer;
	}

	private requireDlqProducer(): LifecycleKafkaDlqProducer {
		if (!this.dlqProducer) {
			throw new Error('Kafka lifecycle DLQ producer is not initialized');
		}
		return this.dlqProducer;
	}

	private requireConfig(): ReturnType<typeof readLifecycleKafkaConsumerConfig> {
		if (!this.config) {
			throw new Error('Kafka lifecycle consumer config is not initialized');
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
