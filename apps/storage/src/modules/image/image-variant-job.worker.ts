import {
	Inject,
	Injectable,
	OnModuleDestroy,
	OnModuleInit,
	Optional,
} from '@nestjs/common';
import {
	IMAGE_VARIANT_JOB_DLQ_TOPIC,
	IMAGE_VARIANT_JOB_TOPIC,
	ImageOperationValidationError,
	ImageVariantJobEvent,
	assertImageVariantJobEvent,
} from '@file/telemetry-contracts/image-operations';
import { readKafkaClientSecurityOptions } from '@file/nest-common';
import {
	Consumer,
	EachMessagePayload,
	Kafka,
	Producer,
	logLevel,
} from 'kafkajs';
import { AppConfig } from '../../config/env.schema';
import { ImageLifecycleMetricsService } from './image-lifecycle-metrics.service';
import {
	IMAGE_VARIANT_JOB_REPOSITORY,
	ImageVariantJobRepository,
} from './image-variant-job.repository';
import { ImageManager } from './strategies/manager';

@Injectable()
export class ImageVariantJobWorker implements OnModuleInit, OnModuleDestroy {
	private readonly enabled = isEnabled();
	private readonly topic =
		process.env.IMAGE_VARIANT_KAFKA_TOPIC ?? IMAGE_VARIANT_JOB_TOPIC;
	private readonly dlqTopic =
		process.env.IMAGE_VARIANT_KAFKA_DLQ_TOPIC ?? IMAGE_VARIANT_JOB_DLQ_TOPIC;
	private consumer?: Consumer;
	private producer?: Producer;
	private reconnectTimer?: NodeJS.Timeout;
	private shuttingDown = false;
	private inFlight = 0;
	private reconnectAttempts = 0;

	constructor(
		private readonly config: AppConfig,
		private readonly imageManager: ImageManager,
		private readonly metrics: ImageLifecycleMetricsService,
		@Optional()
		@Inject(IMAGE_VARIANT_JOB_REPOSITORY)
		private readonly repository?: ImageVariantJobRepository,
	) {}

	onModuleInit(): void {
		this.metrics.setVariantWorkerStatus(this.enabled, false);
		if (!this.enabled) return;
		if (!this.repository) {
			this.metrics.recordVariantFailed(
				new Error('image variant job repository is not configured'),
				0,
			);
			return;
		}
		void this.start();
	}

	async onModuleDestroy(): Promise<void> {
		this.shuttingDown = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		const [consumer, producer] = [this.consumer, this.producer];
		this.consumer = undefined;
		this.producer = undefined;
		this.metrics.setVariantWorkerStatus(this.enabled, false);
		await Promise.all([
			consumer?.disconnect().catch(() => undefined),
			producer?.disconnect().catch(() => undefined),
		]);
	}

	async handlePayload(payload: Buffer | string): Promise<void> {
		const event = assertImageVariantJobEvent(
			JSON.parse(payload.toString()) as unknown,
		);
		await this.process(event);
	}

	private async handleMessage(payload: EachMessagePayload): Promise<void> {
		const { message, partition, topic } = payload;
		if (!message.value) {
			await this.publishPoison(payload, new Error('message value is empty'));
			await this.commit(topic, partition, message.offset);
			return;
		}
		try {
			await this.handlePayload(message.value);
			await this.commit(topic, partition, message.offset);
		} catch (error) {
			if (isValidationError(error)) {
				await this.publishPoison(payload, error);
				await this.commit(topic, partition, message.offset);
				return;
			}
			throw error;
		}
	}

	private async process(job: ImageVariantJobEvent): Promise<void> {
		if (!this.repository) throw new Error('variant repository unavailable');
		const claim = await retryResult(() => this.repository!.claimJob(job));
		if (claim === 'duplicate' || claim === 'discarded') {
			this.metrics.recordVariantDuplicate();
			return;
		}
		if (claim !== 'claimed') {
			throw new Error(`variant job is not claimable: ${job.jobKey}`);
		}

		this.inFlight += 1;
		this.metrics.recordVariantDequeued(0, this.inFlight);
		let completed = false;
		try {
			completed = await retryResult(async () => {
				const generated = await this.imageManager.createPreGeneratedVariant({
					path: job.path,
					name: job.name,
					width: job.width,
					height: job.height,
					format: job.format,
				});
				const committed = await this.repository!.completeJob(job, {
					name: generated.name,
					storageKey: `${job.path}/${generated.name}`,
					inputBytes: generated.inputBytes,
					outputBytes: generated.outputBytes,
					checksum: generated.checksum,
				});
				if (!committed) {
					await this.imageManager.deleteMainImage({
						path: job.path,
						name: generated.name,
					});
				}
				return committed;
			});
		} catch (error) {
			this.inFlight -= 1;
			await this.repository.failJob(job, error);
			this.metrics.recordVariantFailed(error, this.inFlight);
			return;
		}

		this.inFlight -= 1;
		if (completed) {
			this.metrics.recordVariantCompleted(this.inFlight);
		}
		// Ready and cache invalidation are committed atomically by the repository.
	}

	private async publishPoison(
		{ message, partition, topic }: EachMessagePayload,
		error: unknown,
	): Promise<void> {
		if (!this.producer) throw new Error('variant job DLQ unavailable');
		await this.producer.send({
			topic: this.dlqTopic,
			acks: -1,
			messages: [
				{
					key: `${topic}:${partition}:${message.offset}`,
					value: JSON.stringify({
						sourceTopic: topic,
						partition,
						offset: message.offset,
						key: message.key?.toString() ?? null,
						rawPayloadBase64: message.value?.toString('base64') ?? '',
						error: errorMessage(error),
						failedAt: new Date().toISOString(),
					}),
				},
			],
		});
	}

	private async commit(
		topic: string,
		partition: number,
		offset: string,
	): Promise<void> {
		if (!this.consumer) throw new Error('variant job consumer unavailable');
		await this.consumer.commitOffsets([
			{ topic, partition, offset: (BigInt(offset) + 1n).toString() },
		]);
	}

	private async start(): Promise<void> {
		if (this.shuttingDown || this.consumer || !this.repository) return;
		try {
			const kafka = new Kafka({
				clientId: 'storage-variant-worker',
				brokers: this.config.kafkaClientBrokerList,
				...readKafkaClientSecurityOptions(),
				logLevel: logLevel.NOTHING,
				connectionTimeout: readConnectionTimeoutMs(),
				requestTimeout: readConnectionTimeoutMs(),
			});
			const consumer = kafka.consumer({
				groupId:
					process.env.IMAGE_VARIANT_KAFKA_GROUP_ID ??
					'file-image-variant-worker-v1',
			});
			const producer = kafka.producer({ allowAutoTopicCreation: false });
			this.consumer = consumer;
			this.producer = producer;
			await Promise.all([consumer.connect(), producer.connect()]);
			await consumer.subscribe({ topic: this.topic, fromBeginning: false });
			this.reconnectAttempts = 0;
			this.metrics.setVariantWorkerStatus(true, true);
			void consumer
				.run({
					autoCommit: false,
					eachMessage: (payload) => this.handleMessage(payload),
				})
				.catch((error: unknown) => this.onConsumerFailure(error));
		} catch (error) {
			await this.onConsumerFailure(error);
		}
	}

	private async onConsumerFailure(error: unknown): Promise<void> {
		this.metrics.setVariantWorkerStatus(this.enabled, false);
		this.metrics.recordVariantFailed(error, this.inFlight);
		const [consumer, producer] = [this.consumer, this.producer];
		this.consumer = undefined;
		this.producer = undefined;
		await Promise.all([
			consumer?.disconnect().catch(() => undefined),
			producer?.disconnect().catch(() => undefined),
		]);
		if (this.shuttingDown) return;
		this.reconnectAttempts += 1;
		const delay = Math.min(
			10_000,
			500 * 2 ** Math.min(this.reconnectAttempts - 1, 5),
		);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.start();
		}, delay);
		this.reconnectTimer.unref?.();
	}
}

function isEnabled(): boolean {
	const configured = process.env.IMAGE_VARIANT_KAFKA_ENABLED;
	if (configured !== undefined)
		return configured.trim().toLowerCase() === 'true';
	return process.env.NODE_ENV !== 'test';
}

function readConnectionTimeoutMs(): number {
	const parsed = Number(process.env.HEALTH_PROBE_TIMEOUT_MS);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 2_000;
}

async function retryResult<T>(operation: () => Promise<T>): Promise<T> {
	const attempts = readPositive(
		process.env.IMAGE_VARIANT_KAFKA_RETRY_MAX_ATTEMPTS,
		3,
	);
	const backoffMs = readPositive(
		process.env.IMAGE_VARIANT_KAFKA_RETRY_BACKOFF_MS,
		100,
	);
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (attempt === attempts) break;
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
		}
	}
	throw lastError;
}

function isValidationError(error: unknown): boolean {
	return (
		error instanceof SyntaxError ||
		error instanceof ImageOperationValidationError
	);
}

function readPositive(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
