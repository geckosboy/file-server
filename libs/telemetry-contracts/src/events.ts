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

export const ImageTelemetrySourceApp = {
	Storage: 'storage',
	Resize: 'resize',
	Cache: 'cache',
} as const;
export type ImageTelemetrySourceApp = ValueOf<typeof ImageTelemetrySourceApp>;

export const ImageTelemetryEnvironment = {
	Development: 'development',
	Test: 'test',
	Production: 'production',
} as const;
export type ImageTelemetryEnvironment = ValueOf<
	typeof ImageTelemetryEnvironment
>;

export const ImageTelemetryStatus = {
	Success: 'success',
	Failed: 'failed',
} as const;
export type ImageTelemetryStatus = ValueOf<typeof ImageTelemetryStatus>;

export const ImageTelemetryFormat = {
	Png: 'png',
	Jpeg: 'jpeg',
	Jpg: 'jpg',
	Webp: 'webp',
	Unknown: 'unknown',
} as const;
export type ImageTelemetryFormat = ValueOf<typeof ImageTelemetryFormat>;

export type ImageTelemetryEventBase = {
	schemaVersion: typeof IMAGE_TELEMETRY_SCHEMA_VERSION;
	eventId: string;
	eventType: ImageTelemetryEventType;
	occurredAt: string;
	receivedAt?: string;
	sourceApp: ImageTelemetrySourceApp;
	environment: ImageTelemetryEnvironment;
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
};

export type ImageUploadCompletedEvent = ImageTelemetryEventBase & {
	eventType: typeof ImageTelemetryEventType.UploadCompleted;
	sourceApp: typeof ImageTelemetrySourceApp.Storage;
	status: typeof ImageTelemetryStatus.Success;
	imageId: number;
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
	sourceApp: typeof ImageTelemetrySourceApp.Storage;
	status: typeof ImageTelemetryStatus.Failed;
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

export type ImageTelemetryValidationResult =
	{ ok: true; event: ImageTelemetryEvent } | { ok: false; errors: string[] };

const eventValues = Object.values(ImageTelemetryEventType);
const sourceAppValues = Object.values(ImageTelemetrySourceApp);
const environmentValues = Object.values(ImageTelemetryEnvironment);
const statusValues = Object.values(ImageTelemetryStatus);
const formatValues = Object.values(ImageTelemetryFormat);

const eventSourceAppMap: Record<
	ImageTelemetryEventType,
	ImageTelemetrySourceApp
> = {
	[ImageTelemetryEventType.UploadCompleted]: ImageTelemetrySourceApp.Storage,
	[ImageTelemetryEventType.UploadFailed]: ImageTelemetrySourceApp.Storage,
	[ImageTelemetryEventType.ResizeRequested]: ImageTelemetrySourceApp.Resize,
	[ImageTelemetryEventType.ResizeCompleted]: ImageTelemetrySourceApp.Resize,
	[ImageTelemetryEventType.ResizeFailed]: ImageTelemetrySourceApp.Resize,
	[ImageTelemetryEventType.CacheHit]: ImageTelemetrySourceApp.Cache,
	[ImageTelemetryEventType.CacheMiss]: ImageTelemetrySourceApp.Cache,
	[ImageTelemetryEventType.CacheStored]: ImageTelemetrySourceApp.Cache,
	[ImageTelemetryEventType.ReadCompleted]: ImageTelemetrySourceApp.Storage,
	[ImageTelemetryEventType.ReadFailed]: ImageTelemetrySourceApp.Storage,
};

const failedEventTypes = new Set<ImageTelemetryEventType>([
	ImageTelemetryEventType.UploadFailed,
	ImageTelemetryEventType.ResizeFailed,
	ImageTelemetryEventType.ReadFailed,
]);

const cacheEventTypes = new Set<ImageTelemetryEventType>([
	ImageTelemetryEventType.CacheHit,
	ImageTelemetryEventType.CacheMiss,
	ImageTelemetryEventType.CacheStored,
]);

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

	if (!isOneOf(input.eventType, eventValues)) {
		errors.push('지원하지 않는 eventType입니다');
	}

	if (!isNonEmptyString(input.occurredAt)) {
		errors.push('occurredAt은 ISO 날짜 문자열이어야 합니다');
	} else if (!isIsoDateTime(input.occurredAt)) {
		errors.push('occurredAt은 ISO 날짜 문자열이어야 합니다');
	}

	if (input.receivedAt !== undefined) {
		if (
			!isNonEmptyString(input.receivedAt) ||
			!isIsoDateTime(input.receivedAt)
		) {
			errors.push('receivedAt은 ISO 날짜 문자열이어야 합니다');
		}
	}

	if (!isOneOf(input.sourceApp, sourceAppValues)) {
		errors.push('지원하지 않는 sourceApp입니다');
	}

	if (!isOneOf(input.environment, environmentValues)) {
		errors.push('지원하지 않는 environment입니다');
	}

	if (!isOneOf(input.status, statusValues)) {
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

	if (input.width !== undefined && !isDimension(input.width)) {
		errors.push('width는 1부터 4096 사이의 정수여야 합니다');
	}

	if (input.height !== undefined && !isDimension(input.height)) {
		errors.push('height는 1부터 4096 사이의 정수여야 합니다');
	}

	if (input.format !== undefined && !isOneOf(input.format, formatValues)) {
		errors.push('지원하지 않는 format입니다');
	}

	if (
		input.inputBytes !== undefined &&
		!isNonNegativeNumber(input.inputBytes)
	) {
		errors.push('inputBytes는 0 이상의 숫자여야 합니다');
	}

	if (
		input.outputBytes !== undefined &&
		!isNonNegativeNumber(input.outputBytes)
	) {
		errors.push('outputBytes는 0 이상의 숫자여야 합니다');
	}

	if (
		input.durationMs !== undefined &&
		!isNonNegativeNumber(input.durationMs)
	) {
		errors.push('durationMs는 0 이상의 숫자여야 합니다');
	}

	if (isOneOf(input.eventType, eventValues)) {
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

export const assertImageTelemetryEvent = (input: unknown) => {
	const result = normalizeImageTelemetryEvent(input);
	if (!result.ok) {
		throw new Error(result.errors.join(', '));
	}

	return result.event;
};

const validateEventSpecificFields = (
	eventType: ImageTelemetryEventType,
	input: Record<string, unknown>,
	errors: string[],
) => {
	const expectedSourceApp = eventSourceAppMap[eventType];
	if (input.sourceApp !== expectedSourceApp) {
		errors.push(
			`${eventType} 이벤트의 sourceApp은 ${expectedSourceApp}이어야 합니다`,
		);
	}

	if (failedEventTypes.has(eventType)) {
		if (input.status !== ImageTelemetryStatus.Failed) {
			errors.push(`${eventType} 이벤트의 status는 failed여야 합니다`);
		}
		if (!isNonEmptyString(input.errorCode)) {
			errors.push('실패 이벤트에는 errorCode가 필요합니다');
		}
		if (!isNonEmptyString(input.errorMessage)) {
			errors.push('실패 이벤트에는 errorMessage가 필요합니다');
		}
		return;
	}

	if (input.status !== ImageTelemetryStatus.Success) {
		errors.push(`${eventType} 이벤트의 status는 success여야 합니다`);
	}

	if (cacheEventTypes.has(eventType) && !isNonEmptyString(input.cacheKey)) {
		errors.push('캐시 이벤트에는 cacheKey가 필요합니다');
	}

	if (eventType === ImageTelemetryEventType.UploadCompleted) {
		if (!isPositiveInteger(input.imageId)) {
			errors.push('업로드 완료 이벤트에는 양의 정수 imageId가 필요합니다');
		}
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
