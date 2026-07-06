type ValueOf<T> = T[keyof T];

export const IMAGE_LIFECYCLE_TOPIC = 'file.image.lifecycle.v1' as const;
export const IMAGE_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export const ImageLifecycleEventType = {
	UploadCompleted: 'image.upload.completed',
	UploadFailed: 'image.upload.failed',
} as const;
export type ImageLifecycleEventType = ValueOf<typeof ImageLifecycleEventType>;

export const ImageLifecycleSourceApp = {
	Storage: 'storage',
} as const;
export type ImageLifecycleSourceApp = ValueOf<typeof ImageLifecycleSourceApp>;

export const ImageLifecycleEnvironment = {
	Development: 'development',
	Test: 'test',
	Production: 'production',
} as const;
export type ImageLifecycleEnvironment = ValueOf<
	typeof ImageLifecycleEnvironment
>;

export const ImageLifecycleStatus = {
	Success: 'success',
	Failed: 'failed',
} as const;
export type ImageLifecycleStatus = ValueOf<typeof ImageLifecycleStatus>;

export const ImageLifecycleFormat = {
	Png: 'png',
	Jpeg: 'jpeg',
	Jpg: 'jpg',
	Webp: 'webp',
	Unknown: 'unknown',
} as const;
export type ImageLifecycleFormat = ValueOf<typeof ImageLifecycleFormat>;

export type ImageLifecycleEventBase = {
	schemaVersion: typeof IMAGE_LIFECYCLE_SCHEMA_VERSION;
	eventId: string;
	eventType: ImageLifecycleEventType;
	occurredAt: string;
	sourceApp: ImageLifecycleSourceApp;
	environment: ImageLifecycleEnvironment;
	clientServiceId?: string;
	clientServiceSlug?: string;
	requestId?: string;
	traceId?: string;
	imageId?: number;
	path: string;
	name: string;
	originalName?: string;
	imageKey: string;
	format?: ImageLifecycleFormat;
	inputBytes?: number;
	outputBytes?: number;
	durationMs?: number;
	status: ImageLifecycleStatus;
	errorCode?: string;
	errorMessage?: string;
};

export type ImageUploadCompletedLifecycleEvent = ImageLifecycleEventBase & {
	eventType: typeof ImageLifecycleEventType.UploadCompleted;
	sourceApp: typeof ImageLifecycleSourceApp.Storage;
	status: typeof ImageLifecycleStatus.Success;
	inputBytes: number;
	outputBytes: number;
	durationMs: number;
};

export type ImageUploadFailedLifecycleEvent = ImageLifecycleEventBase & {
	eventType: typeof ImageLifecycleEventType.UploadFailed;
	sourceApp: typeof ImageLifecycleSourceApp.Storage;
	status: typeof ImageLifecycleStatus.Failed;
	errorCode: string;
	errorMessage: string;
};

export type ImageLifecycleEvent =
	ImageUploadCompletedLifecycleEvent | ImageUploadFailedLifecycleEvent;

export type ImageLifecycleValidationResult =
	{ ok: true; event: ImageLifecycleEvent } | { ok: false; errors: string[] };

const eventValues = Object.values(ImageLifecycleEventType);
const sourceAppValues = Object.values(ImageLifecycleSourceApp);
const environmentValues = Object.values(ImageLifecycleEnvironment);
const statusValues = Object.values(ImageLifecycleStatus);
const formatValues = Object.values(ImageLifecycleFormat);

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

const isPositiveInteger = (value: unknown): value is number =>
	Number.isInteger(value) && Number(value) > 0;

const isNonNegativeNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const createLifecycleImageKey = (path: string, name: string) => {
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

export const createLifecycleKafkaKey = (event: ImageLifecycleEvent) =>
	[
		event.clientServiceSlug ?? event.clientServiceId ?? 'unknown-service',
		event.imageKey,
		event.eventType,
	].join(':');

export const normalizeImageLifecycleEvent = (
	input: unknown,
): ImageLifecycleValidationResult => {
	const errors: string[] = [];

	if (!isRecord(input)) {
		return { ok: false, errors: ['이벤트 payload는 객체여야 합니다'] };
	}

	if (input.schemaVersion !== IMAGE_LIFECYCLE_SCHEMA_VERSION) {
		errors.push('schemaVersion은 1이어야 합니다');
	}

	if (!isNonEmptyString(input.eventId)) {
		errors.push('eventId는 비어 있지 않은 문자열이어야 합니다');
	}

	if (!isOneOf(input.eventType, eventValues)) {
		errors.push('지원하지 않는 eventType입니다');
	}

	if (!isNonEmptyString(input.occurredAt) || !isIsoDateTime(input.occurredAt)) {
		errors.push('occurredAt은 ISO 날짜 문자열이어야 합니다');
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
			: createLifecycleImageKey(
					input.path,
					isNonEmptyString(input.name) ? input.name : '',
				);

	if (!isNonEmptyString(imageKey)) {
		errors.push('imageKey는 비어 있지 않은 문자열이어야 합니다');
	}

	if (input.imageId !== undefined && !isPositiveInteger(input.imageId)) {
		errors.push('imageId는 양의 정수여야 합니다');
	}

	if (
		input.originalName !== undefined &&
		!isNonEmptyString(input.originalName)
	) {
		errors.push('originalName은 비어 있지 않은 문자열이어야 합니다');
	}

	if (input.format !== undefined && !isOneOf(input.format, formatValues)) {
		errors.push('지원하지 않는 format입니다');
	}

	validateOptionalNonNegativeNumber(input.inputBytes, 'inputBytes', errors);
	validateOptionalNonNegativeNumber(input.outputBytes, 'outputBytes', errors);
	validateOptionalNonNegativeNumber(input.durationMs, 'durationMs', errors);

	if (isOneOf(input.eventType, eventValues)) {
		validateLifecycleSpecificFields(input.eventType, input, errors);
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		event: {
			...input,
			imageKey,
		} as ImageLifecycleEvent,
	};
};

export const validateImageLifecycleEvent = normalizeImageLifecycleEvent;

export const assertImageLifecycleEvent = (input: unknown) => {
	const result = normalizeImageLifecycleEvent(input);
	if (!result.ok) {
		throw new Error(result.errors.join(', '));
	}

	return result.event;
};

const validateLifecycleSpecificFields = (
	eventType: ImageLifecycleEventType,
	input: Record<string, unknown>,
	errors: string[],
) => {
	if (input.sourceApp !== ImageLifecycleSourceApp.Storage) {
		errors.push(`${eventType} 이벤트의 sourceApp은 storage여야 합니다`);
	}

	if (eventType === ImageLifecycleEventType.UploadFailed) {
		if (input.status !== ImageLifecycleStatus.Failed) {
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

	if (input.status !== ImageLifecycleStatus.Success) {
		errors.push(`${eventType} 이벤트의 status는 success여야 합니다`);
	}

	if (eventType === ImageLifecycleEventType.UploadCompleted) {
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
};

const validateOptionalNonNegativeNumber = (
	value: unknown,
	field: string,
	errors: string[],
) => {
	if (value !== undefined && !isNonNegativeNumber(value)) {
		errors.push(`${field}는 0 이상의 숫자여야 합니다`);
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
