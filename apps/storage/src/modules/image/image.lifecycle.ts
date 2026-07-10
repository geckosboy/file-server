import { Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
	assertImageLifecycleEvent,
	createLifecycleImageKey,
	createLifecycleKafkaKey,
	IMAGE_LIFECYCLE_SCHEMA_VERSION,
	IMAGE_LIFECYCLE_TOPIC,
	ImageLifecycleEnvironment,
	ImageLifecycleEvent,
	ImageLifecycleEventType,
	ImageLifecycleFormat,
	ImageLifecycleSourceApp,
	ImageLifecycleStatus,
} from '@file/telemetry-contracts/lifecycle';
import { randomUUID } from 'crypto';
import { lastValueFrom } from 'rxjs';

export {
	createLifecycleKafkaKey,
	IMAGE_LIFECYCLE_TOPIC,
	ImageLifecycleEventType,
	ImageLifecycleStatus,
} from '@file/telemetry-contracts/lifecycle';
export type { ImageLifecycleEvent } from '@file/telemetry-contracts/lifecycle';

type CreateImageLifecycleEventInput = {
	eventId?: string;
	eventType: ImageLifecycleEventType;
	occurredAt?: string;
	environment?: ImageLifecycleEnvironment;
	clientServiceId?: string;
	clientServiceSlug?: string;
	requestId?: string;
	traceId?: string;
	imageId?: number;
	path: string;
	name: string;
	originalName?: string;
	imageKey?: string;
	format?: ImageLifecycleFormat;
	inputBytes?: number;
	outputBytes?: number;
	durationMs?: number;
	status: ImageLifecycleStatus;
	errorCode?: string;
	errorMessage?: string;
};

const getLifecycleEnvironment = (): ImageLifecycleEnvironment => {
	switch (process.env.NODE_ENV) {
		case 'production':
			return ImageLifecycleEnvironment.Production;
		case 'test':
			return ImageLifecycleEnvironment.Test;
		default:
			return ImageLifecycleEnvironment.Development;
	}
};

export const createImageLifecycleEvent = (
	input: CreateImageLifecycleEventInput,
): ImageLifecycleEvent => {
	const event = {
		schemaVersion: IMAGE_LIFECYCLE_SCHEMA_VERSION,
		eventId: input.eventId ?? randomUUID(),
		eventType: input.eventType,
		occurredAt: input.occurredAt ?? new Date().toISOString(),
		sourceApp: ImageLifecycleSourceApp.Storage,
		environment: input.environment ?? getLifecycleEnvironment(),
		clientServiceId: input.clientServiceId,
		clientServiceSlug: input.clientServiceSlug,
		requestId: input.requestId,
		traceId: input.traceId,
		imageId: input.imageId,
		path: input.path,
		name: input.name,
		originalName: input.originalName,
		imageKey: input.imageKey ?? createLifecycleImageKey(input.path, input.name),
		format: input.format,
		inputBytes: input.inputBytes,
		outputBytes: input.outputBytes,
		durationMs: input.durationMs,
		status: input.status,
		errorCode: input.errorCode,
		errorMessage: input.errorMessage,
	};

	return assertImageLifecycleEvent(event);
};

export const publishImageLifecycleEvent = async ({
	client,
	event,
	logger,
}: {
	client?: Pick<ClientKafka, 'emit'>;
	event: ImageLifecycleEvent;
	logger: Logger;
}) => {
	if (!client || typeof client.emit !== 'function') {
		return;
	}

	try {
		await publishImageLifecycleEventOrThrow({ client, event });
	} catch (error) {
		logger.warn(`이미지 lifecycle 이벤트 발행 실패: ${errorToMessage(error)}`);
	}
};

export const publishImageLifecycleEventOrThrow = async ({
	client,
	event,
	topic = IMAGE_LIFECYCLE_TOPIC,
}: {
	client?: Pick<ClientKafka, 'emit'>;
	event: ImageLifecycleEvent;
	topic?: string;
}) => {
	if (!client || typeof client.emit !== 'function') {
		throw new Error('Kafka client is not configured');
	}

	await lastValueFrom(
		client.emit(topic, {
			key: createLifecycleKafkaKey(event),
			value: JSON.stringify(event),
		}),
	);
};

const errorToMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
