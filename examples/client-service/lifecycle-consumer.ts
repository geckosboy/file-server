import { Kafka, logLevel } from 'kafkajs';
import {
	IMAGE_LIFECYCLE_TOPIC,
	ImageLifecycleEventType,
	validateImageLifecycleEvent,
} from '@file/telemetry-contracts/lifecycle';

const printUsage = () => {
	console.log(`Usage:
  pnpm kafka:lifecycle:consume

Environment:
  KAFKA_CLIENT_BROKERS              comma separated broker list, default localhost:9094
  KAFKA_LIFECYCLE_GROUP_ID          consumer group id, default client-service-lifecycle-inspect
  KAFKA_CLIENT_ID                   Kafka client id, default client-service-lifecycle-example
  KAFKA_FROM_BEGINNING              true/false, default true
  CLIENT_SERVICE_SLUG               optional service slug filter
  CLIENT_SERVICE_ID                 optional service id filter
  KAFKA_LIFECYCLE_EVENT_TYPES       comma separated event types, default upload completed/failed

Example:
  KAFKA_CLIENT_BROKERS=localhost:9094 \\
  KAFKA_LIFECYCLE_GROUP_ID=my-service-image-lifecycle-local \\
  CLIENT_SERVICE_SLUG=local-demo-123 \\
  pnpm kafka:lifecycle:consume`);
};

const splitCsv = (value: string | undefined) =>
	(value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);

const parseBoolean = (value: string | undefined, defaultValue: boolean) => {
	if (value === undefined) {
		return defaultValue;
	}

	return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase());
};

const parseJson = (value: Buffer | null) => {
	if (!value) {
		return undefined;
	}

	const text = value.toString('utf8').trim();
	if (!text) {
		return undefined;
	}

	return JSON.parse(text) as unknown;
};

const shouldConsumeEventType = (
	eventType: string,
	allowedEventTypes: readonly string[],
) => allowedEventTypes.length === 0 || allowedEventTypes.includes(eventType);

const shouldConsumeService = ({
	clientServiceId,
	clientServiceSlug,
	serviceIdFilter,
	serviceSlugFilter,
}: {
	clientServiceId?: string;
	clientServiceSlug?: string;
	serviceIdFilter?: string;
	serviceSlugFilter?: string;
}) => {
	if (serviceIdFilter && clientServiceId !== serviceIdFilter) {
		return false;
	}

	if (serviceSlugFilter && clientServiceSlug !== serviceSlugFilter) {
		return false;
	}

	return true;
};

async function main() {
	if (process.argv.includes('-h') || process.argv.includes('--help')) {
		printUsage();
		return;
	}

	const brokers = splitCsv(process.env.KAFKA_CLIENT_BROKERS);
	if (brokers.length === 0) {
		brokers.push('localhost:9094');
	}

	const allowedEventTypes = splitCsv(process.env.KAFKA_LIFECYCLE_EVENT_TYPES);
	if (allowedEventTypes.length === 0) {
		allowedEventTypes.push(
			ImageLifecycleEventType.UploadCompleted,
			ImageLifecycleEventType.UploadFailed,
		);
	}

	const groupId =
		process.env.KAFKA_LIFECYCLE_GROUP_ID ?? 'client-service-lifecycle-inspect';
	const clientId =
		process.env.KAFKA_CLIENT_ID ?? 'client-service-lifecycle-example';
	const fromBeginning = parseBoolean(process.env.KAFKA_FROM_BEGINNING, true);
	const serviceIdFilter = process.env.CLIENT_SERVICE_ID;
	const serviceSlugFilter = process.env.CLIENT_SERVICE_SLUG;

	const kafka = new Kafka({
		clientId,
		brokers,
		logLevel: logLevel.ERROR,
	});
	const consumer = kafka.consumer({ groupId });

	const disconnect = async () => {
		await consumer.disconnect();
		process.exit(0);
	};

	process.once('SIGINT', () => {
		void disconnect();
	});
	process.once('SIGTERM', () => {
		void disconnect();
	});

	await consumer.connect();
	await consumer.subscribe({ topic: IMAGE_LIFECYCLE_TOPIC, fromBeginning });

	console.log(
		JSON.stringify(
			{
				message: 'listening image lifecycle events',
				topic: IMAGE_LIFECYCLE_TOPIC,
				brokers,
				groupId,
				fromBeginning,
				serviceIdFilter: serviceIdFilter ?? null,
				serviceSlugFilter: serviceSlugFilter ?? null,
				allowedEventTypes,
			},
			null,
			2,
		),
	);

	await consumer.run({
		eachMessage: async ({ topic, partition, message }) => {
			const skipInvalid = (errors: string[]) => {
				console.warn(
					JSON.stringify({
						level: 'warn',
						message: 'invalid lifecycle event skipped',
						topic,
						partition,
						offset: message.offset,
						errors,
					}),
				);
			};

			let payload: unknown;
			try {
				payload = parseJson(message.value);
			} catch (error) {
				skipInvalid([
					error instanceof Error ? error.message : 'message value is not JSON',
				]);
				return;
			}

			const parsed = validateImageLifecycleEvent(payload);
			if (!parsed.ok) {
				skipInvalid(parsed.errors);
				return;
			}

			const event = parsed.event;
			if (!shouldConsumeEventType(event.eventType, allowedEventTypes)) {
				return;
			}

			if (
				!shouldConsumeService({
					clientServiceId: event.clientServiceId,
					clientServiceSlug: event.clientServiceSlug,
					serviceIdFilter,
					serviceSlugFilter,
				})
			) {
				return;
			}

			console.log(
				JSON.stringify({
					topic,
					partition,
					offset: message.offset,
					key: message.key?.toString('utf8') ?? null,
					eventId: event.eventId,
					eventType: event.eventType,
					status: event.status,
					clientServiceId: event.clientServiceId ?? null,
					clientServiceSlug: event.clientServiceSlug ?? null,
					requestId: event.requestId ?? null,
					imageId: event.imageId ?? null,
					imageKey: event.imageKey,
					errorCode: event.errorCode ?? null,
					errorMessage: event.errorMessage ?? null,
				}),
			);
		},
	});
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
