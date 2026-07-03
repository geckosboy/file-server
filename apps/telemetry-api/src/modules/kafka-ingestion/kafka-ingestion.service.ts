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
} from './kafka-ingestion.consumer-factory';
import { TelemetryKafkaConsumerStatusService } from './kafka-ingestion.status';

interface ParsedKafkaPayload {
	ok: true;
	payload: unknown;
}

interface InvalidKafkaPayload {
	ok: false;
	reason: string;
}

type KafkaPayloadParseResult = ParsedKafkaPayload | InvalidKafkaPayload;

@Injectable()
export class TelemetryKafkaConsumerService
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	private readonly logger = new Logger(TelemetryKafkaConsumerService.name);
	private consumer?: TelemetryKafkaConsumer;

	constructor(
		private readonly ingestionService: IngestionService,
		private readonly statusService: TelemetryKafkaConsumerStatusService,
		@Inject(TELEMETRY_KAFKA_CONSUMER_FACTORY)
		private readonly consumerFactory: TelemetryKafkaConsumerFactory,
	) {}

	async onApplicationBootstrap() {
		const config = readTelemetryKafkaConsumerConfig();
		this.statusService.configure(config);
		if (!config.enabled) {
			this.logger.log(
				`Kafka telemetry consumer disabled: ${config.disabledReason}`,
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
				`Kafka telemetry consumer connected: ${config.topic} group=${config.groupId}`,
			);
		} catch (error) {
			this.statusService.markDisconnected(error);
			this.logger.error(
				`Kafka telemetry consumer 연결 실패: ${errorToMessage(error)}`,
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
				`Kafka telemetry event 거부: ${result.reason ?? 'unknown reason'}`,
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

export function parseKafkaMessageValue(
	value: unknown,
): KafkaPayloadParseResult {
	if (value === null || value === undefined) {
		return { ok: false, reason: 'Kafka message value is empty' };
	}

	if (Buffer.isBuffer(value)) {
		return parseJsonString(value.toString('utf8'));
	}

	if (value instanceof Uint8Array) {
		return parseJsonString(Buffer.from(value).toString('utf8'));
	}

	if (typeof value === 'string') {
		return parseJsonString(value);
	}

	return { ok: true, payload: unwrapNestKafkaPayload(value) };
}

function parseJsonString(value: string): KafkaPayloadParseResult {
	const trimmed = value.trim();
	if (!trimmed) {
		return { ok: false, reason: 'Kafka message value is empty' };
	}

	try {
		return { ok: true, payload: unwrapNestKafkaPayload(JSON.parse(trimmed)) };
	} catch {
		return { ok: false, reason: 'Kafka message value must be valid JSON' };
	}
}

function unwrapNestKafkaPayload(value: unknown): unknown {
	if (!isRecord(value) || 'schemaVersion' in value || !('value' in value)) {
		return value;
	}

	const nestedValue = value.value;
	if (typeof nestedValue === 'string') {
		try {
			return JSON.parse(nestedValue);
		} catch {
			return value;
		}
	}

	return nestedValue ?? value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
