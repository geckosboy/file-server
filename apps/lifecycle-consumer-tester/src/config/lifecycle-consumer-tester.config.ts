import {
	IMAGE_LIFECYCLE_TOPIC,
	ImageLifecycleEventType,
} from '@file/telemetry-contracts/lifecycle';

export interface LifecycleConsumerTesterConfig {
	enabled: boolean;
	brokers: string[];
	clientId: string;
	groupId: string;
	topic: string;
	fromBeginning: boolean;
	allowedEventTypes: string[];
	clientServiceId?: string;
	clientServiceSlug?: string;
	maxStoredEvents: number;
	disabledReason?: string;
}

const DEFAULT_CLIENT_ID = 'lifecycle-consumer-tester';
const DEFAULT_GROUP_ID = 'lifecycle-consumer-tester-local';
const DEFAULT_BROKERS = ['localhost:9094'];
const DEFAULT_MAX_STORED_EVENTS = 200;
const DEFAULT_ALLOWED_EVENT_TYPES = [
	ImageLifecycleEventType.UploadCompleted,
	ImageLifecycleEventType.UploadFailed,
];

export const readLifecycleConsumerTesterConfig = (
	env: NodeJS.ProcessEnv = process.env,
): LifecycleConsumerTesterConfig => {
	const brokers = parseList(env.KAFKA_CLIENT_BROKERS);
	const effectiveBrokers = brokers.length > 0 ? brokers : DEFAULT_BROKERS;
	const explicitEnabled = parseOptionalBoolean(
		env.LIFECYCLE_CONSUMER_TESTER_ENABLED,
	);
	const requestedEnabled = explicitEnabled ?? env.NODE_ENV !== 'test';
	const enabled = requestedEnabled && effectiveBrokers.length > 0;
	const allowedEventTypes = parseList(env.KAFKA_LIFECYCLE_EVENT_TYPES);

	return {
		enabled,
		brokers: effectiveBrokers,
		clientId: env.LIFECYCLE_KAFKA_CLIENT_ID ?? DEFAULT_CLIENT_ID,
		groupId: env.LIFECYCLE_KAFKA_GROUP_ID ?? DEFAULT_GROUP_ID,
		topic: env.LIFECYCLE_KAFKA_TOPIC ?? IMAGE_LIFECYCLE_TOPIC,
		fromBeginning:
			parseOptionalBoolean(env.LIFECYCLE_KAFKA_FROM_BEGINNING) ?? true,
		allowedEventTypes:
			allowedEventTypes.length > 0
				? allowedEventTypes
				: [...DEFAULT_ALLOWED_EVENT_TYPES],
		clientServiceId: readOptionalString(env.CLIENT_SERVICE_ID),
		clientServiceSlug: readOptionalString(env.CLIENT_SERVICE_SLUG),
		maxStoredEvents: readPositiveInteger(
			env.LIFECYCLE_CONSUMER_TESTER_MAX_EVENTS,
			DEFAULT_MAX_STORED_EVENTS,
		),
		...(enabled
			? {}
			: {
					disabledReason:
						effectiveBrokers.length === 0
							? 'Kafka broker 설정이 없습니다.'
							: 'Lifecycle consumer tester가 비활성화되어 있습니다.',
				}),
	};
};

export const readHttpConfig = (env: NodeJS.ProcessEnv = process.env) => ({
	host: env.HOST ?? '127.0.0.1',
	port: readPositiveInteger(env.PORT, 3110),
});

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

function readOptionalString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function readPositiveInteger(value: string | undefined, fallback: number) {
	if (value === undefined) {
		return fallback;
	}

	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
