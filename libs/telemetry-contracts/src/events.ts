import { randomUUID } from 'crypto';

type ValueOf<T> = T[keyof T];

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
export type ImageTelemetryEventType = ValueOf<typeof ImageTelemetryEventType>;
export const IMAGE_TELEMETRY_EVENT_TYPES = Object.values(
	ImageTelemetryEventType,
) as ImageTelemetryEventType[];

export const ImageTelemetrySourceApp = {
	Storage: 'storage',
	Resize: 'resize',
	Cache: 'cache',
} as const;
export type ImageTelemetrySourceApp = ValueOf<typeof ImageTelemetrySourceApp>;
export const IMAGE_TELEMETRY_SOURCE_APPS = Object.values(
	ImageTelemetrySourceApp,
) as ImageTelemetrySourceApp[];

export const ImageTelemetryEnvironment = {
	Development: 'development',
	Test: 'test',
	Production: 'production',
} as const;
export type ImageTelemetryEnvironment = ValueOf<
	typeof ImageTelemetryEnvironment
>;
export const IMAGE_TELEMETRY_ENVIRONMENTS = Object.values(
	ImageTelemetryEnvironment,
) as ImageTelemetryEnvironment[];

export const ImageTelemetryStatus = {
	Success: 'success',
	Failed: 'failed',
} as const;
export type ImageTelemetryStatus = ValueOf<typeof ImageTelemetryStatus>;
export const IMAGE_TELEMETRY_STATUSES = Object.values(
	ImageTelemetryStatus,
) as ImageTelemetryStatus[];

export const ImageTelemetryFormat = {
	Png: 'png',
	Jpeg: 'jpeg',
	Jpg: 'jpg',
	Webp: 'webp',
	Unknown: 'unknown',
} as const;
export type ImageTelemetryFormat = ValueOf<typeof ImageTelemetryFormat>;
export const IMAGE_TELEMETRY_FORMATS = Object.values(
	ImageTelemetryFormat,
) as ImageTelemetryFormat[];

export const ImageTelemetryStage = {
	StorageRead: 'storage-read',
	CacheOriginFetch: 'cache-origin-fetch',
} as const;
export type ImageTelemetryStage = ValueOf<typeof ImageTelemetryStage>;
export const IMAGE_TELEMETRY_STAGES = Object.values(
	ImageTelemetryStage,
) as ImageTelemetryStage[];

export type ImageTelemetryEventBase = {
	schemaVersion: typeof IMAGE_TELEMETRY_SCHEMA_VERSION;
	eventId: string;
	eventType: ImageTelemetryEventType;
	occurredAt: string;
	receivedAt?: string;
	sourceApp: ImageTelemetrySourceApp;
	environment: ImageTelemetryEnvironment;
	clientServiceId?: string;
	clientServiceSlug?: string;
	requestId?: string;
	traceId?: string;
	imageId?: number;
	path: string;
	name: string;
	originalName?: string;
	imageKey: string;
	cacheKey?: string;
	width?: number;
	height?: number;
	format?: ImageTelemetryFormat;
	inputBytes?: number;
	outputBytes?: number;
	durationMs?: number;
	status: ImageTelemetryStatus;
	stage?: ImageTelemetryStage;
	errorCode?: string;
	errorMessage?: string;
};

export type ImageUploadCompletedEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.UploadCompleted;
	sourceApp: typeof ImageTelemetrySourceApp.Storage;
	status: typeof ImageTelemetryStatus.Success;
	inputBytes: number;
	outputBytes: number;
	durationMs: number;
};

export type ImageUploadFailedEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.UploadFailed;
	sourceApp: typeof ImageTelemetrySourceApp.Storage;
	status: typeof ImageTelemetryStatus.Failed;
	errorCode: string;
	errorMessage: string;
};

export type ImageResizeRequestedEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.ResizeRequested;
	sourceApp: typeof ImageTelemetrySourceApp.Resize;
	status: typeof ImageTelemetryStatus.Success;
};

export type ImageResizeCompletedEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.ResizeCompleted;
	sourceApp: typeof ImageTelemetrySourceApp.Resize;
	status: typeof ImageTelemetryStatus.Success;
	inputBytes: number;
	outputBytes: number;
	durationMs: number;
};

export type ImageResizeFailedEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.ResizeFailed;
	sourceApp: typeof ImageTelemetrySourceApp.Resize;
	status: typeof ImageTelemetryStatus.Failed;
	errorCode: string;
	errorMessage: string;
};

export type ImageCacheHitEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.CacheHit;
	sourceApp: typeof ImageTelemetrySourceApp.Cache;
	status: typeof ImageTelemetryStatus.Success;
	cacheKey: string;
};

export type ImageCacheMissEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.CacheMiss;
	sourceApp: typeof ImageTelemetrySourceApp.Cache;
	status: typeof ImageTelemetryStatus.Success;
	cacheKey: string;
};

export type ImageCacheStoredEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.CacheStored;
	sourceApp: typeof ImageTelemetrySourceApp.Cache;
	status: typeof ImageTelemetryStatus.Success;
	cacheKey: string;
};

export type ImageReadCompletedEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.ReadCompleted;
	sourceApp: typeof ImageTelemetrySourceApp.Storage;
	status: typeof ImageTelemetryStatus.Success;
};

export type ImageReadFailedEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.ReadFailed;
	sourceApp:
		| typeof ImageTelemetrySourceApp.Storage
		| typeof ImageTelemetrySourceApp.Cache;
	status: typeof ImageTelemetryStatus.Failed;
	stage?: ImageTelemetryStage;
	errorCode: string;
	errorMessage: string;
};

export type ImageTelemetryEvent =
	| ImageUploadCompletedEvent
	| ImageUploadFailedEvent
	| ImageResizeRequestedEvent
	| ImageResizeCompletedEvent
	| ImageResizeFailedEvent
	| ImageCacheHitEvent
	| ImageCacheMissEvent
	| ImageCacheStoredEvent
	| ImageReadCompletedEvent
	| ImageReadFailedEvent;

type GeneratedImageTelemetryFields =
	'schemaVersion' | 'eventId' | 'occurredAt' | 'environment' | 'imageKey';

type CreateImageTelemetryEventVariant<TEvent extends ImageTelemetryEvent> =
	Omit<TEvent, GeneratedImageTelemetryFields> & {
		eventId?: string;
		occurredAt?: string;
		environment?: ImageTelemetryEnvironment;
		imageKey?: string;
	};

export type CreateImageTelemetryEventInput =
	ImageTelemetryEvent extends infer TEvent
		? TEvent extends ImageTelemetryEvent
			? CreateImageTelemetryEventVariant<TEvent>
			: never
		: never;

export type ImageTelemetryValidationResult =
	{ ok: true; event: ImageTelemetryEvent } | { ok: false; errors: string[] };

type ImageTelemetryEventRule = {
	sourceApps: readonly ImageTelemetrySourceApp[];
	status: ImageTelemetryStatus;
	requiredFields: readonly (keyof ImageTelemetryEventBase)[];
};

export const IMAGE_TELEMETRY_EVENT_RULES = {
	[ImageTelemetryEventType.UploadCompleted]: {
		sourceApps: [ImageTelemetrySourceApp.Storage],
		status: ImageTelemetryStatus.Success,
		requiredFields: ['inputBytes', 'outputBytes', 'durationMs'],
	},
	[ImageTelemetryEventType.UploadFailed]: {
		sourceApps: [ImageTelemetrySourceApp.Storage],
		status: ImageTelemetryStatus.Failed,
		requiredFields: ['errorCode', 'errorMessage'],
	},
	[ImageTelemetryEventType.ResizeRequested]: {
		sourceApps: [ImageTelemetrySourceApp.Resize],
		status: ImageTelemetryStatus.Success,
		requiredFields: [],
	},
	[ImageTelemetryEventType.ResizeCompleted]: {
		sourceApps: [ImageTelemetrySourceApp.Resize],
		status: ImageTelemetryStatus.Success,
		requiredFields: ['inputBytes', 'outputBytes', 'durationMs'],
	},
	[ImageTelemetryEventType.ResizeFailed]: {
		sourceApps: [ImageTelemetrySourceApp.Resize],
		status: ImageTelemetryStatus.Failed,
		requiredFields: ['errorCode', 'errorMessage'],
	},
	[ImageTelemetryEventType.CacheHit]: {
		sourceApps: [ImageTelemetrySourceApp.Cache],
		status: ImageTelemetryStatus.Success,
		requiredFields: ['cacheKey'],
	},
	[ImageTelemetryEventType.CacheMiss]: {
		sourceApps: [ImageTelemetrySourceApp.Cache],
		status: ImageTelemetryStatus.Success,
		requiredFields: ['cacheKey'],
	},
	[ImageTelemetryEventType.CacheStored]: {
		sourceApps: [ImageTelemetrySourceApp.Cache],
		status: ImageTelemetryStatus.Success,
		requiredFields: ['cacheKey'],
	},
	[ImageTelemetryEventType.ReadCompleted]: {
		sourceApps: [ImageTelemetrySourceApp.Storage],
		status: ImageTelemetryStatus.Success,
		requiredFields: [],
	},
	[ImageTelemetryEventType.ReadFailed]: {
		sourceApps: [
			ImageTelemetrySourceApp.Storage,
			ImageTelemetrySourceApp.Cache,
		],
		status: ImageTelemetryStatus.Failed,
		requiredFields: ['errorCode', 'errorMessage'],
	},
} as const satisfies Record<ImageTelemetryEventType, ImageTelemetryEventRule>;

export const IMAGE_TELEMETRY_KAFKA_RETRY_OPTIONS = {
	initialRetryTime: 300,
	maxRetryTime: 5_000,
	retries: 5,
} as const;

export const IMAGE_TELEMETRY_KAFKA_SEND_OPTIONS = {
	acks: -1,
	timeout: 10_000,
} as const;

const optionalStringFields = [
	'clientServiceId',
	'clientServiceSlug',
	'requestId',
	'traceId',
	'originalName',
	'cacheKey',
	'errorCode',
	'errorMessage',
] as const;

const optionalNumberFields = [
	'inputBytes',
	'outputBytes',
	'durationMs',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(
	value: unknown,
	allowedValues: readonly T[],
): value is T =>
	typeof value === 'string' && allowedValues.includes(value as T);

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === 'string' && value.trim().length > 0;

const isIsoDateTime = (value: string) => Number.isFinite(Date.parse(value));

const isNonNegativeNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
	Number.isInteger(value) && Number(value) > 0;

const isDimension = (value: unknown): value is number =>
	Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 4096;

export const createImageKey = (path: string, name: string) => {
	const normalizedPath = path
		.trim()
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/|\/$/g, '');
	const normalizedName = name.trim().replace(/^\/+/g, '');

	return normalizedPath
		? `${normalizedPath}/${normalizedName}`
		: normalizedName;
};

export const createTelemetryKafkaKey = (event: ImageTelemetryEvent) =>
	`${event.imageKey}:${event.eventType}` as const;

export const getImageTelemetryEnvironment = (): ImageTelemetryEnvironment => {
	switch (process.env.NODE_ENV) {
		case 'production':
			return ImageTelemetryEnvironment.Production;
		case 'test':
			return ImageTelemetryEnvironment.Test;
		default:
			return ImageTelemetryEnvironment.Development;
	}
};

export const normalizeImageFormat = (
	formatOrName?: string | null,
): ImageTelemetryFormat => {
	const rawFormat = formatOrName?.split('.').at(-1)?.toLowerCase();

	return isOneOf(rawFormat, IMAGE_TELEMETRY_FORMATS)
		? rawFormat
		: ImageTelemetryFormat.Unknown;
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

export const createImageTelemetryEvent = (
	input: CreateImageTelemetryEventInput,
): ImageTelemetryEvent =>
	assertImageTelemetryEvent({
		...input,
		schemaVersion: IMAGE_TELEMETRY_SCHEMA_VERSION,
		eventId: input.eventId ?? randomUUID(),
		occurredAt: input.occurredAt ?? new Date().toISOString(),
		environment: input.environment ?? getImageTelemetryEnvironment(),
		imageKey: input.imageKey ?? createImageKey(input.path, input.name),
	});

export const normalizeImageTelemetryEvent = (
	input: unknown,
): ImageTelemetryValidationResult => {
	const errors: string[] = [];

	if (!isRecord(input)) {
		return {
			ok: false,
			errors: ['이벤트 payload는 객체여야 합니다'],
		};
	}

	if (input.schemaVersion !== IMAGE_TELEMETRY_SCHEMA_VERSION) {
		errors.push('schemaVersion은 1이어야 합니다');
	}

	if (!isNonEmptyString(input.eventId)) {
		errors.push('eventId는 비어 있지 않은 문자열이어야 합니다');
	}

	if (!isOneOf(input.eventType, IMAGE_TELEMETRY_EVENT_TYPES)) {
		errors.push('지원하지 않는 eventType입니다');
	}

	if (!isNonEmptyString(input.occurredAt) || !isIsoDateTime(input.occurredAt)) {
		errors.push('occurredAt은 ISO 날짜 문자열이어야 합니다');
	}

	if (
		input.receivedAt !== undefined &&
		(!isNonEmptyString(input.receivedAt) || !isIsoDateTime(input.receivedAt))
	) {
		errors.push('receivedAt은 ISO 날짜 문자열이어야 합니다');
	}

	if (!isOneOf(input.sourceApp, IMAGE_TELEMETRY_SOURCE_APPS)) {
		errors.push('지원하지 않는 sourceApp입니다');
	}

	if (!isOneOf(input.environment, IMAGE_TELEMETRY_ENVIRONMENTS)) {
		errors.push('지원하지 않는 environment입니다');
	}

	if (!isOneOf(input.status, IMAGE_TELEMETRY_STATUSES)) {
		errors.push('지원하지 않는 status입니다');
	}

	if (!isNonEmptyString(input.path)) {
		errors.push('path는 비어 있지 않은 문자열이어야 합니다');
	}

	if (!isNonEmptyString(input.name)) {
		errors.push('name은 비어 있지 않은 문자열이어야 합니다');
	}

	const imageKey =
		isNonEmptyString(input.imageKey) || !isNonEmptyString(input.path)
			? input.imageKey
			: createImageKey(
					input.path,
					isNonEmptyString(input.name) ? input.name : '',
				);

	if (!isNonEmptyString(imageKey)) {
		errors.push('imageKey는 비어 있지 않은 문자열이어야 합니다');
	}

	if (input.imageId !== undefined && !isPositiveInteger(input.imageId)) {
		errors.push('imageId는 양의 정수여야 합니다');
	}

	for (const field of optionalStringFields) {
		if (input[field] !== undefined && !isNonEmptyString(input[field])) {
			errors.push(`${field}는 비어 있지 않은 문자열이어야 합니다`);
		}
	}

	if (input.width !== undefined && !isDimension(input.width)) {
		errors.push('width는 1부터 4096 사이의 정수여야 합니다');
	}

	if (input.height !== undefined && !isDimension(input.height)) {
		errors.push('height는 1부터 4096 사이의 정수여야 합니다');
	}

	if (
		input.format !== undefined &&
		!isOneOf(input.format, IMAGE_TELEMETRY_FORMATS)
	) {
		errors.push('지원하지 않는 format입니다');
	}

	for (const field of optionalNumberFields) {
		if (input[field] !== undefined && !isNonNegativeNumber(input[field])) {
			errors.push(`${field}는 0 이상의 숫자여야 합니다`);
		}
	}

	if (
		input.stage !== undefined &&
		!isOneOf(input.stage, IMAGE_TELEMETRY_STAGES)
	) {
		errors.push('지원하지 않는 stage입니다');
	}

	if (isOneOf(input.eventType, IMAGE_TELEMETRY_EVENT_TYPES)) {
		validateEventSpecificFields(input.eventType, input, errors);
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		event: {
			...input,
			imageKey,
		} as ImageTelemetryEvent,
	};
};

export const validateImageTelemetryEvent = normalizeImageTelemetryEvent;

export function assertImageTelemetryEvent(input: unknown): ImageTelemetryEvent {
	const result = normalizeImageTelemetryEvent(input);
	if (!result.ok) {
		throw new Error(result.errors.join(', '));
	}

	return result.event;
}

const validateEventSpecificFields = (
	eventType: ImageTelemetryEventType,
	input: Record<string, unknown>,
	errors: string[],
) => {
	const rule = IMAGE_TELEMETRY_EVENT_RULES[eventType];
	const allowedSourceApps =
		rule.sourceApps as readonly ImageTelemetrySourceApp[];
	const requiredFields = rule.requiredFields as readonly string[];
	if (
		!isOneOf(input.sourceApp, IMAGE_TELEMETRY_SOURCE_APPS) ||
		!allowedSourceApps.includes(input.sourceApp)
	) {
		errors.push(
			`${eventType} 이벤트의 sourceApp은 ${allowedSourceApps.join('|')}이어야 합니다`,
		);
	}

	if (input.status !== rule.status) {
		errors.push(`${eventType} 이벤트의 status는 ${rule.status}이어야 합니다`);
	}

	if (
		eventType === ImageTelemetryEventType.ReadFailed &&
		input.stage !== undefined
	) {
		const expectedStage =
			input.sourceApp === ImageTelemetrySourceApp.Cache
				? ImageTelemetryStage.CacheOriginFetch
				: ImageTelemetryStage.StorageRead;
		if (input.stage !== expectedStage) {
			errors.push(
				`${eventType} 이벤트의 stage는 ${expectedStage}이어야 합니다`,
			);
		}
	}

	if (
		eventType === ImageTelemetryEventType.ReadFailed &&
		input.sourceApp === ImageTelemetrySourceApp.Cache &&
		!isNonEmptyString(input.cacheKey)
	) {
		errors.push('cache read 실패 이벤트에는 cacheKey가 필요합니다');
	}

	if (requiredFields.includes('cacheKey')) {
		if (!isNonEmptyString(input.cacheKey)) {
			errors.push('캐시 이벤트에는 cacheKey가 필요합니다');
		}
	}

	if (requiredFields.includes('errorCode')) {
		if (!isNonEmptyString(input.errorCode)) {
			errors.push('실패 이벤트에는 errorCode가 필요합니다');
		}
		if (!isNonEmptyString(input.errorMessage)) {
			errors.push('실패 이벤트에는 errorMessage가 필요합니다');
		}
	}

	if (eventType === ImageTelemetryEventType.UploadCompleted) {
		validateRequiredNonNegativeNumber(
			input.inputBytes,
			'업로드 완료 이벤트에는 inputBytes가 필요합니다',
			errors,
		);
		validateRequiredNonNegativeNumber(
			input.outputBytes,
			'업로드 완료 이벤트에는 outputBytes가 필요합니다',
			errors,
		);
		validateRequiredNonNegativeNumber(
			input.durationMs,
			'업로드 완료 이벤트에는 durationMs가 필요합니다',
			errors,
		);
	}

	if (eventType === ImageTelemetryEventType.ResizeCompleted) {
		validateRequiredNonNegativeNumber(
			input.inputBytes,
			'리사이즈 완료 이벤트에는 inputBytes가 필요합니다',
			errors,
		);
		validateRequiredNonNegativeNumber(
			input.outputBytes,
			'리사이즈 완료 이벤트에는 outputBytes가 필요합니다',
			errors,
		);
		validateRequiredNonNegativeNumber(
			input.durationMs,
			'리사이즈 완료 이벤트에는 durationMs가 필요합니다',
			errors,
		);
	}
};

const validateRequiredNonNegativeNumber = (
	value: unknown,
	message: string,
	errors: string[],
) => {
	if (!isNonNegativeNumber(value)) {
		errors.push(message);
	}
};

export type ImageTelemetryDeliveryResult =
	| { status: 'published' }
	| { status: 'skipped'; reason: 'client_unavailable' }
	| { status: 'failed'; failureCount: number; errorMessage: string };

let imageTelemetryDeliveryFailureCount = 0;

export const getImageTelemetryDeliveryFailureCount = () =>
	imageTelemetryDeliveryFailureCount;

export const getImageTelemetryProducerStatus = () => ({
	topic: IMAGE_TELEMETRY_TOPIC,
	acknowledgements: 'all' as const,
	maxRetries: IMAGE_TELEMETRY_KAFKA_RETRY_OPTIONS.retries,
	deliveryFailureCount: imageTelemetryDeliveryFailureCount,
});

export const resetImageTelemetryDeliveryFailureCount = () => {
	imageTelemetryDeliveryFailureCount = 0;
};

export const deliverImageTelemetryEvent = async ({
	deliver,
	event,
	onFailure,
}: {
	deliver?: (event: ImageTelemetryEvent) => Promise<unknown>;
	event: ImageTelemetryEvent;
	onFailure?: (failure: { errorMessage: string; failureCount: number }) => void;
}): Promise<ImageTelemetryDeliveryResult> => {
	if (!deliver) {
		return { status: 'skipped', reason: 'client_unavailable' };
	}

	try {
		const validatedEvent = assertImageTelemetryEvent(event);
		await deliver(validatedEvent);
		return { status: 'published' };
	} catch (error) {
		imageTelemetryDeliveryFailureCount += 1;
		const { errorMessage } = createFailedTelemetryFields(error);
		try {
			onFailure?.({
				errorMessage,
				failureCount: imageTelemetryDeliveryFailureCount,
			});
		} catch {
			// A metric/log callback must never change business request semantics.
		}
		return {
			status: 'failed',
			failureCount: imageTelemetryDeliveryFailureCount,
			errorMessage,
		};
	}
};

const exampleBase = {
	schemaVersion: IMAGE_TELEMETRY_SCHEMA_VERSION,
	occurredAt: '2026-07-10T00:00:00.000Z',
	environment: ImageTelemetryEnvironment.Test,
	path: 'products/image',
	name: 'sample.png',
	imageKey: 'products/image/sample.png',
	format: ImageTelemetryFormat.Png,
} as const;

export const IMAGE_TELEMETRY_EVENT_EXAMPLES: Readonly<
	Record<ImageTelemetryEventType, ImageTelemetryEvent>
> = {
	[ImageTelemetryEventType.UploadCompleted]: assertImageTelemetryEvent({
		...exampleBase,
		eventId: 'telemetry-upload-completed',
		eventType: ImageTelemetryEventType.UploadCompleted,
		sourceApp: ImageTelemetrySourceApp.Storage,
		inputBytes: 1_024,
		outputBytes: 900,
		durationMs: 12,
		status: ImageTelemetryStatus.Success,
	}),
	[ImageTelemetryEventType.UploadFailed]: assertImageTelemetryEvent({
		...exampleBase,
		eventId: 'telemetry-upload-failed',
		eventType: ImageTelemetryEventType.UploadFailed,
		sourceApp: ImageTelemetrySourceApp.Storage,
		status: ImageTelemetryStatus.Failed,
		errorCode: 'UploadError',
		errorMessage: 'upload failed',
	}),
	[ImageTelemetryEventType.ResizeRequested]: assertImageTelemetryEvent({
		...exampleBase,
		eventId: 'telemetry-resize-requested',
		eventType: ImageTelemetryEventType.ResizeRequested,
		sourceApp: ImageTelemetrySourceApp.Resize,
		width: 320,
		height: 240,
		status: ImageTelemetryStatus.Success,
	}),
	[ImageTelemetryEventType.ResizeCompleted]: assertImageTelemetryEvent({
		...exampleBase,
		eventId: 'telemetry-resize-completed',
		eventType: ImageTelemetryEventType.ResizeCompleted,
		sourceApp: ImageTelemetrySourceApp.Resize,
		width: 320,
		height: 240,
		inputBytes: 1_024,
		outputBytes: 512,
		durationMs: 20,
		status: ImageTelemetryStatus.Success,
	}),
	[ImageTelemetryEventType.ResizeFailed]: assertImageTelemetryEvent({
		...exampleBase,
		eventId: 'telemetry-resize-failed',
		eventType: ImageTelemetryEventType.ResizeFailed,
		sourceApp: ImageTelemetrySourceApp.Resize,
		status: ImageTelemetryStatus.Failed,
		errorCode: 'ResizeError',
		errorMessage: 'resize failed',
	}),
	[ImageTelemetryEventType.CacheHit]: assertImageTelemetryEvent({
		...exampleBase,
		eventId: 'telemetry-cache-hit',
		eventType: ImageTelemetryEventType.CacheHit,
		sourceApp: ImageTelemetrySourceApp.Cache,
		cacheKey: 'products/image/sample.png:320x240',
		status: ImageTelemetryStatus.Success,
	}),
	[ImageTelemetryEventType.CacheMiss]: assertImageTelemetryEvent({
		...exampleBase,
		eventId: 'telemetry-cache-miss',
		eventType: ImageTelemetryEventType.CacheMiss,
		sourceApp: ImageTelemetrySourceApp.Cache,
		cacheKey: 'products/image/sample.png:320x240',
		status: ImageTelemetryStatus.Success,
	}),
	[ImageTelemetryEventType.CacheStored]: assertImageTelemetryEvent({
		...exampleBase,
		eventId: 'telemetry-cache-stored',
		eventType: ImageTelemetryEventType.CacheStored,
		sourceApp: ImageTelemetrySourceApp.Cache,
		cacheKey: 'products/image/sample.png:320x240',
		status: ImageTelemetryStatus.Success,
	}),
	[ImageTelemetryEventType.ReadCompleted]: assertImageTelemetryEvent({
		...exampleBase,
		eventId: 'telemetry-read-completed',
		eventType: ImageTelemetryEventType.ReadCompleted,
		sourceApp: ImageTelemetrySourceApp.Storage,
		status: ImageTelemetryStatus.Success,
	}),
	[ImageTelemetryEventType.ReadFailed]: assertImageTelemetryEvent({
		...exampleBase,
		eventId: 'telemetry-read-failed',
		eventType: ImageTelemetryEventType.ReadFailed,
		sourceApp: ImageTelemetrySourceApp.Cache,
		cacheKey: 'products/image/sample.png:320x240',
		stage: ImageTelemetryStage.CacheOriginFetch,
		status: ImageTelemetryStatus.Failed,
		errorCode: 'OriginReadError',
		errorMessage: 'origin read failed',
	}),
};

const baseRequiredFields = [
	'schemaVersion',
	'eventId',
	'eventType',
	'occurredAt',
	'sourceApp',
	'environment',
	'path',
	'name',
	'imageKey',
	'status',
] as const;

export const createImageTelemetryJsonSchema = () => ({
	type: 'object',
	additionalProperties: true,
	required: [...baseRequiredFields],
	properties: {
		schemaVersion: {
			type: 'integer',
			enum: [IMAGE_TELEMETRY_SCHEMA_VERSION],
		},
		eventId: { type: 'string', minLength: 1 },
		eventType: { type: 'string', enum: IMAGE_TELEMETRY_EVENT_TYPES },
		occurredAt: { type: 'string', format: 'date-time' },
		receivedAt: { type: 'string', format: 'date-time' },
		sourceApp: { type: 'string', enum: IMAGE_TELEMETRY_SOURCE_APPS },
		environment: { type: 'string', enum: IMAGE_TELEMETRY_ENVIRONMENTS },
		clientServiceId: { type: 'string', minLength: 1 },
		clientServiceSlug: { type: 'string', minLength: 1 },
		requestId: { type: 'string', minLength: 1 },
		traceId: { type: 'string', minLength: 1 },
		imageId: { type: 'integer', minimum: 1 },
		path: { type: 'string', minLength: 1 },
		name: { type: 'string', minLength: 1 },
		originalName: { type: 'string', minLength: 1 },
		imageKey: { type: 'string', minLength: 1 },
		cacheKey: { type: 'string', minLength: 1 },
		width: { type: 'integer', minimum: 1, maximum: 4096 },
		height: { type: 'integer', minimum: 1, maximum: 4096 },
		format: { type: 'string', enum: IMAGE_TELEMETRY_FORMATS },
		inputBytes: { type: 'number', minimum: 0 },
		outputBytes: { type: 'number', minimum: 0 },
		durationMs: { type: 'number', minimum: 0 },
		status: { type: 'string', enum: IMAGE_TELEMETRY_STATUSES },
		stage: { type: 'string', enum: IMAGE_TELEMETRY_STAGES },
		errorCode: { type: 'string', minLength: 1 },
		errorMessage: { type: 'string', minLength: 1 },
	},
	oneOf: IMAGE_TELEMETRY_EVENT_TYPES.map((eventType) => {
		const rule = IMAGE_TELEMETRY_EVENT_RULES[eventType];
		return {
			required: [...rule.requiredFields],
			properties: {
				eventType: { type: 'string', enum: [eventType] },
				sourceApp: { type: 'string', enum: [...rule.sourceApps] },
				status: { type: 'string', enum: [rule.status] },
			},
		};
	}),
});

export const createImageTelemetryAsyncApiDocument = () => ({
	asyncapi: '3.1.0',
	id: 'urn:file-server:file-image-telemetry:v1',
	info: {
		title: 'File Image Telemetry Events',
		version: '1.0.0',
		description:
			'Generated from @file/telemetry-contracts/events. Delivery is at-least-once and eventId is the idempotency key.',
	},
	defaultContentType: 'application/json',
	channels: {
		fileImageTelemetryV1: {
			address: IMAGE_TELEMETRY_TOPIC,
			messages: {
				imageTelemetryEvent: {
					$ref: '#/components/messages/ImageTelemetryEvent',
				},
			},
		},
	},
	operations: {
		publishImageTelemetry: {
			action: 'send',
			channel: { $ref: '#/channels/fileImageTelemetryV1' },
			messages: [
				{
					$ref: '#/channels/fileImageTelemetryV1/messages/imageTelemetryEvent',
				},
			],
		},
	},
	components: {
		messages: {
			ImageTelemetryEvent: {
				name: 'ImageTelemetryEvent',
				contentType: 'application/json',
				payload: { $ref: '#/components/schemas/ImageTelemetryEvent' },
				examples: IMAGE_TELEMETRY_EVENT_TYPES.map((eventType) => ({
					name: eventType,
					payload: IMAGE_TELEMETRY_EVENT_EXAMPLES[eventType],
				})),
			},
		},
		schemas: {
			ImageTelemetryEvent: createImageTelemetryJsonSchema(),
		},
	},
});
