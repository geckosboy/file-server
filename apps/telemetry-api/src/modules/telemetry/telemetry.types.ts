import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEnvironment,
	ImageTelemetryEventBase,
	ImageTelemetryEventType,
	ImageTelemetryFormat,
	ImageTelemetrySourceApp,
	ImageTelemetryStatus,
} from '@file/telemetry-contracts/events';

export { IMAGE_TELEMETRY_TOPIC };
export type RuntimeEnvironment = ImageTelemetryEnvironment;
export type ImageFormat = ImageTelemetryFormat;
export type SourceApp = ImageTelemetrySourceApp;
export type TelemetryStatus = ImageTelemetryStatus;
export type { ImageTelemetryEventType };

export type UnknownRecord = Record<string, unknown>;

export type ImageTelemetryEvent = Omit<
	ImageTelemetryEventBase,
	'receivedAt'
> & {
	receivedAt: string;
	rawPayload: UnknownRecord;
};

export interface ImageAssetSummary {
	imageKey: string;
	imageId?: number;
	path: string;
	name: string;
	originalName?: string;
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
	variantId?: string;
	status?: string;
	storageKey?: string;
	checksum?: string;
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
	clientServiceId?: string;
	clientServiceSlug?: string;
	path?: string;
	name?: string;
	imageKey?: string;
	requestId?: string;
	search?: string;
	cursor?: string;
	limit?: number;
}

export interface ImageFilter extends Partial<TelemetryRange> {
	q?: string;
	clientServiceId?: string;
	clientServiceSlug?: string;
	sort?: 'reads' | 'resizes' | 'cacheMisses' | 'failures' | 'lastSeenAt';
	order?: 'asc' | 'desc';
	cursor?: string;
	limit?: number;
}

export interface TimeseriesQuery extends Partial<TelemetryRange> {
	interval?: 'minute' | 'hour' | 'day';
	clientServiceId?: string;
	clientServiceSlug?: string;
}
