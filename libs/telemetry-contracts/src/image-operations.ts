import { randomUUID } from 'crypto';

type ValueOf<T> = T[keyof T];

export const IMAGE_VARIANT_JOB_TOPIC = 'file.image.variant.jobs.v1' as const;
export const IMAGE_VARIANT_JOB_DLQ_TOPIC =
	'file.image.variant.jobs.v1.dlq' as const;
export const IMAGE_CACHE_INVALIDATION_TOPIC =
	'file.image.cache-invalidation.v1' as const;
export const IMAGE_CACHE_INVALIDATION_DLQ_TOPIC =
	'file.image.cache-invalidation.v1.dlq' as const;
export const IMAGE_OPERATION_SCHEMA_VERSION = 1 as const;

export const ImageVariantJobFormat = {
	Png: 'png',
	Jpeg: 'jpeg',
	Webp: 'webp',
} as const;
export type ImageVariantJobFormat = ValueOf<typeof ImageVariantJobFormat>;

export const ImageCacheInvalidationReason = {
	Upload: 'upload',
	Delete: 'delete',
	VariantReady: 'variant-ready',
} as const;
export type ImageCacheInvalidationReason = ValueOf<
	typeof ImageCacheInvalidationReason
>;

export interface ImageVariantJobEvent {
	schemaVersion: typeof IMAGE_OPERATION_SCHEMA_VERSION;
	eventId: string;
	eventType: 'image.variant.requested';
	occurredAt: string;
	jobKey: string;
	assetId: string;
	clientServiceId: string;
	path: string;
	name: string;
	sourceChecksum: string;
	width?: number;
	height?: number;
	format: ImageVariantJobFormat;
}

export interface ImageCacheInvalidationEvent {
	schemaVersion: typeof IMAGE_OPERATION_SCHEMA_VERSION;
	eventId: string;
	eventType: 'image.cache.invalidated';
	occurredAt: string;
	clientServiceId: string;
	path: string;
	name: string;
	reason: ImageCacheInvalidationReason;
	assetId?: string;
	sourceChecksum?: string;
}

export type ImageOperationValidationResult<T> =
	{ ok: true; event: T } | { ok: false; errors: string[] };

export class ImageOperationValidationError extends Error {
	constructor(readonly errors: string[]) {
		super(errors.join(', '));
		this.name = 'ImageOperationValidationError';
	}
}

export const createImageVariantJobKey = (input: {
	assetId: string;
	sourceChecksum: string;
	width?: number;
	height?: number;
	format: ImageVariantJobFormat;
}) =>
	[
		input.assetId,
		input.width ?? 'auto',
		input.height ?? 'auto',
		input.format,
		input.sourceChecksum,
	].join(':');

export const createImageVariantJobEvent = (
	input: Omit<
		ImageVariantJobEvent,
		'schemaVersion' | 'eventId' | 'eventType' | 'occurredAt' | 'jobKey'
	> &
		Partial<Pick<ImageVariantJobEvent, 'eventId' | 'occurredAt' | 'jobKey'>>,
): ImageVariantJobEvent => {
	const event: ImageVariantJobEvent = {
		...input,
		schemaVersion: IMAGE_OPERATION_SCHEMA_VERSION,
		eventId: input.eventId ?? randomUUID(),
		eventType: 'image.variant.requested',
		occurredAt: input.occurredAt ?? new Date().toISOString(),
		jobKey:
			input.jobKey ??
			createImageVariantJobKey({
				assetId: input.assetId,
				sourceChecksum: input.sourceChecksum,
				width: input.width,
				height: input.height,
				format: input.format,
			}),
	};
	return assertImageVariantJobEvent(event);
};

export const createImageCacheInvalidationEvent = (
	input: Omit<
		ImageCacheInvalidationEvent,
		'schemaVersion' | 'eventId' | 'eventType' | 'occurredAt'
	> &
		Partial<Pick<ImageCacheInvalidationEvent, 'eventId' | 'occurredAt'>>,
): ImageCacheInvalidationEvent => {
	const event: ImageCacheInvalidationEvent = {
		...input,
		schemaVersion: IMAGE_OPERATION_SCHEMA_VERSION,
		eventId: input.eventId ?? randomUUID(),
		eventType: 'image.cache.invalidated',
		occurredAt: input.occurredAt ?? new Date().toISOString(),
	};
	return assertImageCacheInvalidationEvent(event);
};

export const validateImageVariantJobEvent = (
	input: unknown,
): ImageOperationValidationResult<ImageVariantJobEvent> => {
	const errors: string[] = [];
	if (!isRecord(input)) {
		return { ok: false, errors: ['payload는 object여야 합니다'] };
	}
	validateBase(input, 'image.variant.requested', errors);
	validateString(input.jobKey, 'jobKey', errors);
	validateString(input.assetId, 'assetId', errors);
	validateString(input.clientServiceId, 'clientServiceId', errors);
	validateString(input.path, 'path', errors);
	validateString(input.name, 'name', errors);
	validateString(input.sourceChecksum, 'sourceChecksum', errors);
	validateOptionalDimension(input.width, 'width', errors);
	validateOptionalDimension(input.height, 'height', errors);
	if (input.width === undefined && input.height === undefined) {
		errors.push('width 또는 height 중 하나는 필요합니다');
	}
	if (!Object.values(ImageVariantJobFormat).includes(input.format as never)) {
		errors.push('지원하지 않는 format입니다');
	}
	return errors.length
		? { ok: false, errors }
		: { ok: true, event: input as unknown as ImageVariantJobEvent };
};

export const validateImageCacheInvalidationEvent = (
	input: unknown,
): ImageOperationValidationResult<ImageCacheInvalidationEvent> => {
	const errors: string[] = [];
	if (!isRecord(input)) {
		return { ok: false, errors: ['payload는 object여야 합니다'] };
	}
	validateBase(input, 'image.cache.invalidated', errors);
	validateString(input.clientServiceId, 'clientServiceId', errors);
	validateString(input.path, 'path', errors);
	validateString(input.name, 'name', errors);
	if (
		!Object.values(ImageCacheInvalidationReason).includes(input.reason as never)
	) {
		errors.push('지원하지 않는 reason입니다');
	}
	validateOptionalString(input.assetId, 'assetId', errors);
	validateOptionalString(input.sourceChecksum, 'sourceChecksum', errors);
	return errors.length
		? { ok: false, errors }
		: { ok: true, event: input as unknown as ImageCacheInvalidationEvent };
};

export const assertImageVariantJobEvent = (input: unknown) => {
	const result = validateImageVariantJobEvent(input);
	if (!result.ok) throw new ImageOperationValidationError(result.errors);
	return result.event;
};

export const assertImageCacheInvalidationEvent = (input: unknown) => {
	const result = validateImageCacheInvalidationEvent(input);
	if (!result.ok) throw new ImageOperationValidationError(result.errors);
	return result.event;
};

export const createImageVariantJobKafkaKey = (event: ImageVariantJobEvent) =>
	event.jobKey;

export const createImageCacheInvalidationKafkaKey = (
	event: ImageCacheInvalidationEvent,
) => `${event.clientServiceId}:${event.path}/${event.name}`;

function validateBase(
	input: Record<string, unknown>,
	eventType: string,
	errors: string[],
) {
	if (input.schemaVersion !== IMAGE_OPERATION_SCHEMA_VERSION) {
		errors.push('schemaVersion은 1이어야 합니다');
	}
	if (input.eventType !== eventType) {
		errors.push(`eventType은 ${eventType}이어야 합니다`);
	}
	validateString(input.eventId, 'eventId', errors);
	if (
		typeof input.occurredAt !== 'string' ||
		!Number.isFinite(Date.parse(input.occurredAt))
	) {
		errors.push('occurredAt은 ISO date 문자열이어야 합니다');
	}
}

function validateString(value: unknown, field: string, errors: string[]) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		errors.push(`${field}은 비어 있지 않은 문자열이어야 합니다`);
	}
}

function validateOptionalString(
	value: unknown,
	field: string,
	errors: string[],
) {
	if (value !== undefined) validateString(value, field, errors);
}

function validateOptionalDimension(
	value: unknown,
	field: string,
	errors: string[],
) {
	if (
		value !== undefined &&
		(!Number.isInteger(value) ||
			(value as number) < 1 ||
			(value as number) > 4096)
	) {
		errors.push(`${field}은 1~4096 정수여야 합니다`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
