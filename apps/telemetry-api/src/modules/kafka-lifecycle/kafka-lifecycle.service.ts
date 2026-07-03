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
} from './kafka-lifecycle.consumer-factory';
import { LifecycleKafkaConsumerStatusService } from './kafka-lifecycle.status';

@Injectable()
export class LifecycleKafkaConsumerService
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	private readonly logger = new Logger(LifecycleKafkaConsumerService.name);
	private consumer?: LifecycleKafkaConsumer;

	constructor(
		private readonly ingestionService: LifecycleIngestionService,
		private readonly statusService: LifecycleKafkaConsumerStatusService,
		@Inject(LIFECYCLE_KAFKA_CONSUMER_FACTORY)
		private readonly consumerFactory: LifecycleKafkaConsumerFactory,
	) {}

	async onApplicationBootstrap() {
		const config = readLifecycleKafkaConsumerConfig();
		this.statusService.configure(config);
		if (!config.enabled) {
			this.logger.log(
				`Kafka lifecycle consumer disabled: ${config.disabledReason}`,
			);
			return;
		}

		try {
			this.consumer = this.consumerFactory.create(config);
			await this.consumer.connect();
			await this.consumer.subscribe({
				topic: config.topic,
				fromBeginning: config.fromBeginning,
			});
			await this.consumer.run({
				eachMessage: (payload) => this.handleMessage(payload),
			});
			this.statusService.markConnected();
			this.logger.log(
				`Kafka lifecycle consumer connected: ${config.topic} group=${config.groupId}`,
			);
		} catch (error) {
			this.statusService.markDisconnected(error);
			this.logger.error(
				`Kafka lifecycle consumer 연결 실패: ${errorToMessage(error)}`,
			);
		}
	}

	async onApplicationShutdown() {
		if (!this.consumer) {
			return;
		}

		try {
			await this.consumer.disconnect();
		} finally {
			this.statusService.markDisconnected();
		}
	}

	async handleMessage({ message }: EachMessagePayload): Promise<void> {
		const result = await this.ingestMessageValue(message.value);
		this.statusService.markConsumed();
		if (!result.accepted) {
			this.logger.warn(
				`Kafka lifecycle event 거부: ${result.reason ?? 'unknown reason'}`,
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
}

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
