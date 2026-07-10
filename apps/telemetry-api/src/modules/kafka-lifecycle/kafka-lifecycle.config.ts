import { IMAGE_LIFECYCLE_TOPIC } from '@file/telemetry-contracts/lifecycle';

export interface LifecycleKafkaConsumerConfig {
	enabled: boolean;
	brokers: string[];
	clientId: string;
	groupId: string;
	topic: string;
	dlqTopic: string;
	fromBeginning: boolean;
	retryMaxAttempts: number;
	retryBackoffMs: number;
	connectRetryBackoffMs: number;
	connectRetryMaxBackoffMs: number;
	lagRefreshIntervalMs: number;
	disabledReason?: string;
}

const DEFAULT_CLIENT_ID = 'telemetry-api-lifecycle';
const DEFAULT_GROUP_ID = 'file-telemetry-api-lifecycle';
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 100;
const DEFAULT_CONNECT_RETRY_BACKOFF_MS = 500;
const DEFAULT_CONNECT_RETRY_MAX_BACKOFF_MS = 10_000;
const DEFAULT_LAG_REFRESH_INTERVAL_MS = 5_000;

export const readLifecycleKafkaConsumerConfig = (
	env: NodeJS.ProcessEnv = process.env,
): LifecycleKafkaConsumerConfig => {
	const brokers = parseList(
		env.LIFECYCLE_KAFKA_BROKERS ?? env.KAFKA_CLIENT_BROKERS,
	);
	const explicitEnabled = parseOptionalBoolean(
		env.LIFECYCLE_KAFKA_CONSUMER_ENABLED,
	);
	const requestedEnabled = explicitEnabled ?? env.NODE_ENV !== 'test';
	const enabled = requestedEnabled && brokers.length > 0;
	const topic = env.LIFECYCLE_KAFKA_TOPIC ?? IMAGE_LIFECYCLE_TOPIC;

	return {
		enabled,
		brokers,
		clientId: env.LIFECYCLE_KAFKA_CLIENT_ID ?? DEFAULT_CLIENT_ID,
		groupId: env.LIFECYCLE_KAFKA_GROUP_ID ?? DEFAULT_GROUP_ID,
		topic,
		dlqTopic: env.LIFECYCLE_KAFKA_DLQ_TOPIC ?? `${topic}.dlq`,
		fromBeginning:
			parseOptionalBoolean(env.LIFECYCLE_KAFKA_FROM_BEGINNING) ?? false,
		retryMaxAttempts: parseInteger(
			env.LIFECYCLE_KAFKA_RETRY_MAX_ATTEMPTS,
			DEFAULT_RETRY_MAX_ATTEMPTS,
			1,
		),
		retryBackoffMs: parseInteger(
			env.LIFECYCLE_KAFKA_RETRY_BACKOFF_MS,
			DEFAULT_RETRY_BACKOFF_MS,
			0,
		),
		connectRetryBackoffMs: parseInteger(
			env.LIFECYCLE_KAFKA_CONNECT_RETRY_BACKOFF_MS,
			DEFAULT_CONNECT_RETRY_BACKOFF_MS,
			1,
		),
		connectRetryMaxBackoffMs: parseInteger(
			env.LIFECYCLE_KAFKA_CONNECT_RETRY_MAX_BACKOFF_MS,
			DEFAULT_CONNECT_RETRY_MAX_BACKOFF_MS,
			1,
		),
		lagRefreshIntervalMs: parseInteger(
			env.LIFECYCLE_KAFKA_LAG_REFRESH_INTERVAL_MS,
			DEFAULT_LAG_REFRESH_INTERVAL_MS,
			1,
		),
		...(enabled
			? {}
			: {
					disabledReason:
						brokers.length === 0
							? 'Kafka broker 설정이 없습니다.'
							: 'Kafka lifecycle consumer가 비활성화되어 있습니다.',
				}),
	};
};

function parseList(value: string | undefined): string[] {
	return (
		value
			?.split(',')
			.map((item) => item.trim())
			.filter(Boolean) ?? []
	);
}

function parseInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
): number {
	const parsed = value === undefined ? Number.NaN : Number(value);
	return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}

	switch (value.trim().toLowerCase()) {
		case '1':
		case 'true':
		case 'yes':
		case 'on':
			return true;
		case '0':
		case 'false':
		case 'no':
		case 'off':
			return false;
		default:
			return undefined;
	}
}
