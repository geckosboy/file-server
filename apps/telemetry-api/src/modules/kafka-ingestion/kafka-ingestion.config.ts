import { IMAGE_TELEMETRY_TOPIC } from '../telemetry/telemetry.types';

export interface TelemetryKafkaConsumerConfig {
	enabled: boolean;
	brokers: string[];
	clientId: string;
	groupId: string;
	topic: string;
	fromBeginning: boolean;
	disabledReason?: string;
}

const DEFAULT_CLIENT_ID = 'telemetry-api';
const DEFAULT_GROUP_ID = 'file-telemetry-api';

export const readTelemetryKafkaConsumerConfig = (
	env: NodeJS.ProcessEnv = process.env,
): TelemetryKafkaConsumerConfig => {
	const brokers = parseList(
		env.TELEMETRY_KAFKA_BROKERS ?? env.KAFKA_CLIENT_BROKERS,
	);
	const explicitEnabled = parseOptionalBoolean(
		env.TELEMETRY_KAFKA_CONSUMER_ENABLED,
	);
	const requestedEnabled = explicitEnabled ?? env.NODE_ENV !== 'test';
	const enabled = requestedEnabled && brokers.length > 0;

	return {
		enabled,
		brokers,
		clientId: env.TELEMETRY_KAFKA_CLIENT_ID ?? DEFAULT_CLIENT_ID,
		groupId: env.TELEMETRY_KAFKA_GROUP_ID ?? DEFAULT_GROUP_ID,
		topic: env.TELEMETRY_KAFKA_TOPIC ?? IMAGE_TELEMETRY_TOPIC,
		fromBeginning:
			parseOptionalBoolean(env.TELEMETRY_KAFKA_FROM_BEGINNING) ?? false,
		...(enabled
			? {}
			: {
					disabledReason:
						brokers.length === 0
							? 'Kafka broker 설정이 없습니다.'
							: 'Kafka consumer가 비활성화되어 있습니다.',
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
