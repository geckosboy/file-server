import { Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { randomUUID } from 'crypto';
import { lastValueFrom } from 'rxjs';

export const IMAGE_TELEMETRY_TOPIC = 'file.image.events.v1' as const;
export const IMAGE_TELEMETRY_SCHEMA_VERSION = 1 as const;

export const ImageTelemetryEventType = {
	UploadCompleted: 'image.upload.completed',
	UploadFailed: 'image.upload.failed',
	ResizeRequested: 'image.resize.requested',
	ResizeCompleted: 'image.resize.completed',
	ResizeFailed: 'image.resize.failed',
	CacheHit: 'image.cache.hit',
	CacheMiss: 'image.cache.miss',
	CacheStored: 'image.cache.stored',
	ReadCompleted: 'image.read.completed',
	ReadFailed: 'image.read.failed',
} as const;

type ImageTelemetryEnvironment = 'development' | 'test' | 'production';
type ImageTelemetryFormat = 'png' | 'jpeg' | 'jpg' | 'webp' | 'unknown';
type ImageTelemetrySourceApp = 'storage' | 'resize' | 'cache';
type ImageTelemetryStatus = 'success' | 'failed';

type ImageTelemetryEventTypeValue =
	(typeof ImageTelemetryEventType)[keyof typeof ImageTelemetryEventType];

export interface ImageTelemetryEvent {
	schemaVersion: typeof IMAGE_TELEMETRY_SCHEMA_VERSION;
	eventId: string;
	eventType: ImageTelemetryEventTypeValue;
	occurredAt: string;
	sourceApp: ImageTelemetrySourceApp;
	environment: ImageTelemetryEnvironment;
	clientServiceId?: string;
	clientServiceSlug?: string;
	requestId?: string;
	traceId?: string;
	imageId?: number;
	path: string;
	name: string;
	imageKey: string;
	cacheKey?: string;
	width?: number;
	height?: number;
	format?: ImageTelemetryFormat;
	inputBytes?: number;
	outputBytes?: number;
	durationMs?: number;
	status: ImageTelemetryStatus;
	errorCode?: string;
	errorMessage?: string;
}

export type CreateImageTelemetryEventInput = Omit<
	ImageTelemetryEvent,
	'schemaVersion' | 'eventId' | 'occurredAt' | 'environment' | 'imageKey'
> & {
	eventId?: string;
	occurredAt?: string;
	environment?: ImageTelemetryEnvironment;
	imageKey?: string;
};

const getTelemetryEnvironment = (): ImageTelemetryEnvironment => {
	switch (process.env.NODE_ENV) {
		case 'production':
			return 'production';
		case 'test':
			return 'test';
		default:
			return 'development';
	}
};

export const createImageKey = ({
	name,
	path,
}: {
	path: string;
	name: string;
}) => `${path}/${name}`;

export const normalizeImageFormat = (
	formatOrName?: string | null,
): ImageTelemetryFormat => {
	const rawFormat = formatOrName?.split('.').at(-1)?.toLowerCase();

	switch (rawFormat) {
		case 'png':
		case 'jpeg':
		case 'jpg':
		case 'webp':
			return rawFormat;
		default:
			return 'unknown';
	}
};

export const createImageTelemetryEvent = (
	input: CreateImageTelemetryEventInput,
): ImageTelemetryEvent => {
	const imageKey = input.imageKey ?? createImageKey(input);

	return {
		schemaVersion: IMAGE_TELEMETRY_SCHEMA_VERSION,
		eventId: input.eventId ?? randomUUID(),
		occurredAt: input.occurredAt ?? new Date().toISOString(),
		environment: input.environment ?? getTelemetryEnvironment(),
		...input,
		imageKey,
	};
};

export const createFailedTelemetryFields = (error: unknown) => {
	if (error instanceof Error) {
		return {
			errorCode: error.name,
			errorMessage: error.message,
		};
	}

	return {
		errorCode: 'UnknownError',
		errorMessage: String(error),
	};
};

export const publishImageTelemetryEvent = async ({
	client,
	event,
	logger,
}: {
	client?: Pick<ClientKafka, 'emit'>;
	event: ImageTelemetryEvent;
	logger: Logger;
}) => {
	if (!client || typeof client.emit !== 'function') {
		return;
	}

	try {
		await lastValueFrom(
			client.emit(IMAGE_TELEMETRY_TOPIC, {
				key: `${event.imageKey}:${event.eventType}`,
				value: JSON.stringify(event),
			}),
		);
	} catch (error) {
		const { errorMessage } = createFailedTelemetryFields(error);
		logger.warn(`이미지 텔레메트리 이벤트 발행 실패: ${errorMessage}`);
	}
};
