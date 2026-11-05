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
import {
	KafkaLagProbe,
	readKafkaConsumerLag,
} from '../kafka/kafka-consumer-lag';

@Injectable()
export class LifecycleKafkaConsumerService
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	private readonly logger = new Logger(LifecycleKafkaConsumerService.name);
	private consumer?: LifecycleKafkaConsumer;
	private dlqProducer?: LifecycleKafkaDlqProducer;
	private lagProbe?: KafkaLagProbe;
	private config?: ReturnType<typeof readLifecycleKafkaConsumerConfig>;
	private reconnectTimer?: NodeJS.Timeout;
	private lagRefreshTimer?: NodeJS.Timeout;
	private reconnectAttempt = 0;
	private consumerGeneration = 0;
	private consumerEventUnsubscribers: Array<() => void> = [];
	private shuttingDown = false;

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

		await this.connectConsumer();
	}

	async onApplicationShutdown() {
		this.shuttingDown = true;
		this.clearTimers();
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
			this.statusService.markDeadLettered();
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
		this.consumerGeneration += 1;
		this.detachConsumerStatusHandlers();
		const consumer = this.consumer;
		const dlqProducer = this.dlqProducer;
		const lagProbe = this.lagProbe;
		this.consumer = undefined;
		this.dlqProducer = undefined;
		this.lagProbe = undefined;
		await Promise.allSettled([
			consumer?.disconnect(),
			dlqProducer?.disconnect(),
			lagProbe?.disconnect(),
		]);
	}

	private async connectConsumer(): Promise<void> {
		const config = this.requireConfig();
		if (this.shuttingDown) {
			return;
		}

		try {
			const generation = ++this.consumerGeneration;
			this.consumer = this.consumerFactory.create(config);
			this.attachConsumerStatusHandlers(this.consumer, generation);
			this.dlqProducer = this.consumerFactory.createDlqProducer(config);
			this.lagProbe = this.consumerFactory.createLagProbe(config);
			await this.consumer.connect();
			await this.dlqProducer.connect();
			await this.lagProbe.connect();
			await this.consumer.subscribe({
				topic: config.topic,
				fromBeginning: config.fromBeginning,
			});
			await this.consumer.run({
				autoCommit: false,
				eachMessage: (payload) => this.handleMessage(payload),
			});
			await this.refreshLag();
			this.reconnectAttempt = 0;
			this.startLagRefresh();
			this.logger.log(
				`Kafka lifecycle consumer run loop started: ${config.topic} group=${config.groupId}`,
			);
		} catch (error) {
			await this.disconnectClients();
			this.statusService.markDisconnected(error);
			this.logger.error(
				`Kafka lifecycle consumer 연결 실패: ${errorToMessage(error)}`,
			);
			this.scheduleReconnect();
		}
	}

	private attachConsumerStatusHandlers(
		consumer: LifecycleKafkaConsumer,
		generation: number,
	): void {
		const isCurrent = () =>
			!this.shuttingDown &&
			this.consumer === consumer &&
			this.consumerGeneration === generation;
		this.consumerEventUnsubscribers = [
			consumer.on(consumer.events.CRASH, (event) => {
				if (isCurrent()) {
					this.statusService.markConsumerInactive(event.payload.error);
				}
			}),
			consumer.on(consumer.events.REBALANCING, () => {
				if (isCurrent()) {
					this.statusService.markConsumerInactive();
				}
			}),
			consumer.on(consumer.events.STOP, () => {
				if (isCurrent()) {
					this.statusService.markConsumerInactive();
				}
			}),
			consumer.on(consumer.events.DISCONNECT, () => {
				if (isCurrent()) {
					this.statusService.markConsumerInactive();
				}
			}),
			consumer.on(consumer.events.GROUP_JOIN, () => {
				if (isCurrent()) {
					this.statusService.markConnected();
				}
			}),
		];
	}

	private detachConsumerStatusHandlers(): void {
		for (const unsubscribe of this.consumerEventUnsubscribers.splice(0)) {
			unsubscribe();
		}
	}

	private scheduleReconnect(): void {
		const config = this.requireConfig();
		if (this.shuttingDown || this.reconnectTimer) {
			return;
		}
		this.reconnectAttempt += 1;
		const delayMs = Math.min(
			config.connectRetryBackoffMs * 2 ** (this.reconnectAttempt - 1),
			config.connectRetryMaxBackoffMs,
		);
		this.statusService.markReconnectScheduled(this.reconnectAttempt, delayMs);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connectConsumer();
		}, delayMs);
		this.reconnectTimer.unref?.();
	}

	private startLagRefresh(): void {
		const config = this.requireConfig();
		if (this.lagRefreshTimer) {
			clearInterval(this.lagRefreshTimer);
		}
		this.lagRefreshTimer = setInterval(() => {
			void this.refreshLag().catch((error) => {
				this.statusService.markLagUnavailable(error);
				this.logger.error(
					`Kafka lifecycle lag 조회 실패: ${errorToMessage(error)}`,
				);
			});
		}, config.lagRefreshIntervalMs);
		this.lagRefreshTimer.unref?.();
	}

	private async refreshLag(): Promise<void> {
		const config = this.requireConfig();
		if (!this.lagProbe) {
			throw new Error('Kafka lifecycle lag probe is not initialized');
		}
		this.statusService.markLag(
			await readKafkaConsumerLag(this.lagProbe, {
				topic: config.topic,
				groupId: config.groupId,
			}),
		);
	}

	private clearTimers(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		if (this.lagRefreshTimer) {
			clearInterval(this.lagRefreshTimer);
			this.lagRefreshTimer = undefined;
		}
	}
}

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
