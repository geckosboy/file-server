export const IMAGE_TELEMETRY_TOPIC = 'file.image.events.v1';

export const ImageTelemetryEventTypes = [
	'image.upload.completed',
	'image.upload.failed',
	'image.resize.requested',
	'image.resize.completed',
	'image.resize.failed',
	'image.cache.hit',
	'image.cache.miss',
	'image.cache.stored',
	'image.read.completed',
	'image.read.failed',
] as const;

export type ImageTelemetryEventType = (typeof ImageTelemetryEventTypes)[number];

export const SourceApps = ['storage', 'resize', 'cache'] as const;
export type SourceApp = (typeof SourceApps)[number];

export const RuntimeEnvironments = [
	'development',
	'test',
	'production',
] as const;
export type RuntimeEnvironment = (typeof RuntimeEnvironments)[number];

export const TelemetryStatuses = ['success', 'failed'] as const;
export type TelemetryStatus = (typeof TelemetryStatuses)[number];

export const ImageFormats = ['png', 'jpeg', 'jpg', 'webp', 'unknown'] as const;
export type ImageFormat = (typeof ImageFormats)[number];

export type UnknownRecord = Record<string, unknown>;

export interface ImageTelemetryEvent {
	schemaVersion: 1;
	eventId: string;
	eventType: ImageTelemetryEventType;
	occurredAt: string;
	receivedAt: string;
	sourceApp: SourceApp;
	environment: RuntimeEnvironment;
	requestId?: string;
	traceId?: string;
	imageId?: number;
	path: string;
	name: string;
	imageKey: string;
	cacheKey?: string;
	width?: number;
	height?: number;
	format?: ImageFormat;
	inputBytes?: number;
	outputBytes?: number;
	durationMs?: number;
	status: TelemetryStatus;
	errorCode?: string;
	errorMessage?: string;
	rawPayload: UnknownRecord;
}

export interface ImageAssetSummary {
	imageKey: string;
	imageId?: number;
	path: string;
	name: string;
	format?: ImageFormat;
	originalBytes?: number;
	storedBytes?: number;
	firstSeenAt: string;
	lastSeenAt: string;
	lastUploadedAt?: string;
	lastReadAt?: string;
	totalEvents: number;
	totalReads: number;
	totalResizes: number;
	totalCacheHits: number;
	totalCacheMisses: number;
	totalFailures: number;
}

export interface ImageVariantSummary {
	variantKey: string;
	imageKey: string;
	width?: number;
	height?: number;
	format?: ImageFormat;
	outputBytes?: number;
	resizeCount: number;
	avgDurationMs: number | null;
	p95DurationMs: number | null;
	lastResizedAt?: string;
}

export interface TelemetryMetrics {
	validationFailureCount: number;
	insertFailureCount: number;
	lastConsumedEventAt: string | null;
}

export interface TelemetryRange {
	from: string;
	to: string;
}

export interface EventFilter extends Partial<TelemetryRange> {
	eventType?: string;
	sourceApp?: string;
	status?: string;
	path?: string;
	name?: string;
	imageKey?: string;
	requestId?: string;
	cursor?: string;
	limit?: number;
}

export interface ImageFilter extends Partial<TelemetryRange> {
	q?: string;
	sort?: 'reads' | 'resizes' | 'cacheMisses' | 'failures' | 'lastSeenAt';
	order?: 'asc' | 'desc';
	cursor?: string;
	limit?: number;
}

export interface TimeseriesQuery extends Partial<TelemetryRange> {
	interval?: 'minute' | 'hour' | 'day';
}
