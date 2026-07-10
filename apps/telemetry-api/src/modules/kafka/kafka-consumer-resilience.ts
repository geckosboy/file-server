import { EachMessagePayload } from 'kafkajs';
import { IngestionResult } from '../ingestion/ingestion.service';

export interface KafkaConsumerRetryPolicy {
	retryMaxAttempts: number;
	retryBackoffMs: number;
}

export interface KafkaDeadLetterEnvelope {
	schemaVersion: 1;
	sourceTopic: string;
	partition: number;
	offset: string;
	key: string | null;
	rawPayload: string | null;
	rawPayloadEncoding: 'base64';
	error: string;
	deadLetteredAt: string;
}

export interface KafkaMessageProcessingResult {
	outcome: 'committed' | 'dead-lettered';
	attempts: number;
	ingestion: IngestionResult;
}

interface KafkaMessageProcessingOptions {
	payload: EachMessagePayload;
	retryPolicy: KafkaConsumerRetryPolicy;
	ingest: (value: Buffer | null) => Promise<IngestionResult>;
	publishDeadLetter: (envelope: KafkaDeadLetterEnvelope) => Promise<void>;
	commitOffset: (offset: string) => Promise<void>;
	delay?: (milliseconds: number) => Promise<void>;
	now?: () => Date;
}

export async function processKafkaMessageWithResilience({
	payload,
	retryPolicy,
	ingest,
	publishDeadLetter,
	commitOffset,
	delay = wait,
	now = () => new Date(),
}: KafkaMessageProcessingOptions): Promise<KafkaMessageProcessingResult> {
	const maxAttempts = Math.max(1, retryPolicy.retryMaxAttempts);
	let lastError: unknown = new Error('Kafka ingestion failed');

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const result = await ingest(payload.message.value);
			if (result.accepted) {
				await commitOffset(nextKafkaOffset(payload.message.offset));
				return { outcome: 'committed', attempts: attempt, ingestion: result };
			}

			if (result.reason !== 'insert_failed') {
				await publishDeadLetter(
					createKafkaDeadLetterEnvelope(
						payload,
						result.reason ?? 'validation_failed',
						now(),
					),
				);
				await commitOffset(nextKafkaOffset(payload.message.offset));
				return {
					outcome: 'dead-lettered',
					attempts: attempt,
					ingestion: result,
				};
			}

			lastError = new Error(result.reason);
		} catch (error) {
			lastError = error;
		}

		if (attempt < maxAttempts) {
			await payload.heartbeat();
			await delay(retryPolicy.retryBackoffMs);
		}
	}

	throw lastError;
}

export function createKafkaDeadLetterEnvelope(
	payload: EachMessagePayload,
	error: string,
	deadLetteredAt = new Date(),
): KafkaDeadLetterEnvelope {
	return {
		schemaVersion: 1,
		sourceTopic: payload.topic,
		partition: payload.partition,
		offset: payload.message.offset,
		key: payload.message.key?.toString('base64') ?? null,
		rawPayload: payload.message.value?.toString('base64') ?? null,
		rawPayloadEncoding: 'base64',
		error,
		deadLetteredAt: deadLetteredAt.toISOString(),
	};
}

export function nextKafkaOffset(offset: string): string {
	return (BigInt(offset) + 1n).toString();
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) =>
		setTimeout(resolve, Math.max(0, milliseconds)),
	);
}
