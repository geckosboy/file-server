import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit,
} from '@nestjs/common';
import {
	IMAGE_CACHE_INVALIDATION_DLQ_TOPIC,
	IMAGE_CACHE_INVALIDATION_TOPIC,
	ImageOperationValidationError,
	assertImageCacheInvalidationEvent,
} from '@file/telemetry-contracts/image-operations';
import { readKafkaClientSecurityOptions } from '@file/nest-common';
import {
	Consumer,
	EachMessagePayload,
	Kafka,
	Producer,
	logLevel,
} from 'kafkajs';
import { hostname } from 'os';
import { AppConfig } from '../../config/env.schema';
import { ImageService } from './image.service';

export interface CacheInvalidationConsumerMetrics {
	enabled: boolean;
	connected: boolean;
	ready: boolean;
	topic: string;
	dlqTopic: string;
	groupId: string;
	processedTotal: number;
	invalidatedEntriesTotal: number;
	validationFailureTotal: number;
	handlerFailureTotal: number;
	dlqTotal: number;
	reconnectAttempts: number;
	lastProcessedAt: string | null;
	lastError: string | null;
}

@Injectable()
export class CacheInvalidationConsumerService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly logger = new Logger(CacheInvalidationConsumerService.name);
	private readonly enabled = isEnabled();
	private readonly topic =
		process.env.CACHE_INVALIDATION_KAFKA_TOPIC ??
		IMAGE_CACHE_INVALIDATION_TOPIC;
	private readonly dlqTopic =
		process.env.CACHE_INVALIDATION_KAFKA_DLQ_TOPIC ??
		IMAGE_CACHE_INVALIDATION_DLQ_TOPIC;
	private readonly groupId = readGroupId();
	private consumer?: Consumer;
	private producer?: Producer;
	private reconnectTimer?: NodeJS.Timeout;
	private shuttingDown = false;
	private connected = false;
	private processedTotal = 0;
	private invalidatedEntriesTotal = 0;
	private validationFailureTotal = 0;
	private handlerFailureTotal = 0;
	private dlqTotal = 0;
	private reconnectAttempts = 0;
	private lastProcessedAt?: string;
	private lastError?: string;

	constructor(
		private readonly config: AppConfig,
		private readonly imageService: ImageService,
	) {}

	onModuleInit(): void {
		if (!this.enabled) return;
		void this.start();
	}

	async onModuleDestroy(): Promise<void> {
		this.shuttingDown = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		const [consumer, producer] = [this.consumer, this.producer];
		this.consumer = undefined;
		this.producer = undefined;
		this.connected = false;
		await Promise.all([
			consumer?.disconnect().catch(() => undefined),
			producer?.disconnect().catch(() => undefined),
		]);
	}

	handlePayload(payload: Buffer | string): void {
		const event = assertImageCacheInvalidationEvent(
			JSON.parse(payload.toString()) as unknown,
		);
		const { deletedCount } = this.imageService.deleteCacheImage({
			clientServiceId: event.clientServiceId,
			path: event.path,
			name: event.name,
		});
		this.processedTotal = increment(this.processedTotal);
		this.invalidatedEntriesTotal = incrementBy(
			this.invalidatedEntriesTotal,
			deletedCount,
		);
		this.lastProcessedAt = new Date().toISOString();
		this.lastError = undefined;
	}

	getMetrics(): CacheInvalidationConsumerMetrics {
		return {
			enabled: this.enabled,
			connected: this.connected,
			ready: !this.enabled || this.connected,
			topic: this.topic,
			dlqTopic: this.dlqTopic,
			groupId: this.groupId,
			processedTotal: this.processedTotal,
			invalidatedEntriesTotal: this.invalidatedEntriesTotal,
			validationFailureTotal: this.validationFailureTotal,
			handlerFailureTotal: this.handlerFailureTotal,
			dlqTotal: this.dlqTotal,
			reconnectAttempts: this.reconnectAttempts,
			lastProcessedAt: this.lastProcessedAt ?? null,
			lastError: this.lastError ?? null,
		};
	}

	private async handleMessage(payload: EachMessagePayload): Promise<void> {
		const { message, partition, topic } = payload;
		if (!message.value) {
			await this.publishPoison(payload, new Error('message value is empty'));
			await this.commit(topic, partition, message.offset);
			return;
		}

		try {
			await retry(() => Promise.resolve(this.handlePayload(message.value!)));
			await this.commit(topic, partition, message.offset);
		} catch (error) {
			if (isValidationError(error)) {
				this.validationFailureTotal = increment(this.validationFailureTotal);
				await this.publishPoison(payload, error);
				await this.commit(topic, partition, message.offset);
				return;
			}
			this.handlerFailureTotal = increment(this.handlerFailureTotal);
			this.lastError = errorMessage(error);
			throw error;
		}
	}

	private async publishPoison(
		{ message, partition, topic }: EachMessagePayload,
		error: unknown,
	): Promise<void> {
		if (!this.producer) throw new Error('cache invalidation DLQ unavailable');
		await this.producer.send({
			topic: this.dlqTopic,
			acks: -1,
			messages: [
				{
					key: `${topic}:${partition}:${message.offset}:${this.groupId}`,
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
		this.dlqTotal = increment(this.dlqTotal);
	}

	private async commit(
		topic: string,
		partition: number,
		offset: string,
	): Promise<void> {
		if (!this.consumer)
			throw new Error('cache invalidation consumer unavailable');
		await this.consumer.commitOffsets([
			{ topic, partition, offset: (BigInt(offset) + 1n).toString() },
		]);
	}

	private async start(): Promise<void> {
		if (this.shuttingDown || this.consumer) return;
		try {
			const kafka = new Kafka({
				clientId: `cache-invalidation-${hostname()}`,
				brokers: this.config.kafkaClientBrokerList,
				...readKafkaClientSecurityOptions(),
				logLevel: logLevel.NOTHING,
				connectionTimeout: readConnectionTimeoutMs(),
				requestTimeout: readConnectionTimeoutMs(),
			});
			const consumer = kafka.consumer({ groupId: this.groupId });
			const producer = kafka.producer({ allowAutoTopicCreation: false });
			this.consumer = consumer;
			this.producer = producer;
			await Promise.all([consumer.connect(), producer.connect()]);
			await consumer.subscribe({ topic: this.topic, fromBeginning: false });
			this.connected = true;
			this.lastError = undefined;
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
		this.connected = false;
		this.lastError = errorMessage(error);
		const [consumer, producer] = [this.consumer, this.producer];
		this.consumer = undefined;
		this.producer = undefined;
		await Promise.all([
			consumer?.disconnect().catch(() => undefined),
			producer?.disconnect().catch(() => undefined),
		]);
		if (this.shuttingDown) return;
		this.reconnectAttempts = increment(this.reconnectAttempts);
		this.logger.warn(
			`cache invalidation consumer disconnected: ${this.lastError}`,
		);
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
	const configured = process.env.CACHE_INVALIDATION_KAFKA_ENABLED;
	if (configured !== undefined)
		return configured.trim().toLowerCase() === 'true';
	return process.env.NODE_ENV !== 'test';
}

function readGroupId(): string {
	const configured = process.env.CACHE_INVALIDATION_KAFKA_GROUP_ID;
	if (configured?.trim()) return configured.trim();
	return `file-cache-invalidation-${sanitize(hostname())}-${process.pid}`;
}

function sanitize(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'replica';
}

function readConnectionTimeoutMs(): number {
	const parsed = Number(process.env.HEALTH_PROBE_TIMEOUT_MS);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 2_000;
}

async function retry(operation: () => Promise<void>): Promise<void> {
	const attempts = readPositive(
		process.env.CACHE_INVALIDATION_KAFKA_RETRY_MAX_ATTEMPTS,
		3,
	);
	const backoffMs = readPositive(
		process.env.CACHE_INVALIDATION_KAFKA_RETRY_BACKOFF_MS,
		100,
	);
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await operation();
			return;
		} catch (error) {
			lastError = error;
			if (isValidationError(error) || attempt === attempts) break;
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

function increment(value: number): number {
	return incrementBy(value, 1);
}

function incrementBy(value: number, amount: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, value + Math.max(0, amount));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
