import { Type } from 'class-transformer';
import {
	IsISO8601,
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	Max,
	Min,
} from 'class-validator';

import {
	ImageLifecycleEvent,
	ImageLifecycleEventType,
	ImageLifecycleStatus,
} from './lifecycle';
import {
	ImageTelemetryEvent,
	ImageTelemetryEventBase,
	ImageTelemetryEventType,
	ImageTelemetrySourceApp,
	ImageTelemetryStatus,
} from './events';

type ValueOf<T> = T[keyof T];

export const DashboardInterval = {
	Minute: 'minute',
	Hour: 'hour',
	Day: 'day',
} as const;
export type DashboardInterval = ValueOf<typeof DashboardInterval>;

export const DashboardMetric = {
	CacheHitRate: 'cacheHitRate',
	TotalResizes: 'totalResizes',
	P95DurationMs: 'p95DurationMs',
	FailureRate: 'failureRate',
} as const;
export type DashboardMetric = ValueOf<typeof DashboardMetric>;

export const ImageListSortField = {
	Reads: 'reads',
	Resizes: 'resizes',
	CacheMisses: 'cacheMisses',
	Failures: 'failures',
	LastSeenAt: 'lastSeenAt',
} as const;
export type ImageListSortField = ValueOf<typeof ImageListSortField>;

export const SortOrder = {
	Asc: 'asc',
	Desc: 'desc',
} as const;
export type SortOrder = ValueOf<typeof SortOrder>;

export class DashboardSummaryQueryDto {
	@IsISO8601()
	from!: string;

	@IsISO8601()
	to!: string;

	@IsOptional()
	@IsString()
	clientServiceId?: string;

	@IsOptional()
	@IsString()
	clientServiceSlug?: string;
}

export class DashboardTimeseriesQueryDto extends DashboardSummaryQueryDto {
	@IsIn(Object.values(DashboardInterval))
	interval!: DashboardInterval;

	@IsOptional()
	@IsString()
	metrics?: string;
}

export class EventsListQueryDto {
	@IsOptional()
	@IsISO8601()
	from?: string;

	@IsOptional()
	@IsISO8601()
	to?: string;

	@IsOptional()
	@IsIn(Object.values(ImageTelemetryEventType))
	eventType?: ImageTelemetryEventType;

	@IsOptional()
	@IsIn(Object.values(ImageTelemetrySourceApp))
	sourceApp?: ImageTelemetrySourceApp;

	@IsOptional()
	@IsIn(Object.values(ImageTelemetryStatus))
	status?: ImageTelemetryStatus;

	@IsOptional()
	@IsString()
	path?: string;

	@IsOptional()
	@IsString()
	name?: string;

	@IsOptional()
	@IsString()
	imageKey?: string;

	@IsOptional()
	@IsString()
	clientServiceId?: string;

	@IsOptional()
	@IsString()
	clientServiceSlug?: string;

	@IsOptional()
	@IsString()
	requestId?: string;

	@IsOptional()
	@IsString()
	cursor?: string;

	@Type(() => Number)
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number;
}

export class LifecycleEventsListQueryDto {
	@IsOptional()
	@IsISO8601()
	from?: string;

	@IsOptional()
	@IsISO8601()
	to?: string;

	@IsOptional()
	@IsIn(Object.values(ImageLifecycleEventType))
	eventType?: ImageLifecycleEventType;

	@IsOptional()
	@IsIn(Object.values(ImageLifecycleStatus))
	status?: ImageLifecycleStatus;

	@IsOptional()
	@IsString()
	path?: string;

	@IsOptional()
	@IsString()
	name?: string;

	@IsOptional()
	@IsString()
	imageKey?: string;

	@IsOptional()
	@IsString()
	clientServiceId?: string;

	@IsOptional()
	@IsString()
	clientServiceSlug?: string;

	@IsOptional()
	@IsString()
	requestId?: string;

	@IsOptional()
	@IsString()
	cursor?: string;

	@Type(() => Number)
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number;
}

export class ImagesListQueryDto {
	@IsOptional()
	@IsISO8601()
	from?: string;

	@IsOptional()
	@IsISO8601()
	to?: string;

	@IsOptional()
	@IsString()
	q?: string;

	@IsOptional()
	@IsString()
	clientServiceId?: string;

	@IsOptional()
	@IsString()
	clientServiceSlug?: string;

	@IsOptional()
	@IsIn(Object.values(ImageListSortField))
	sort?: ImageListSortField;

	@IsOptional()
	@IsIn(Object.values(SortOrder))
	order?: SortOrder;

	@IsOptional()
	@IsString()
	cursor?: string;

	@Type(() => Number)
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number;
}

export class ImageResizeRecommendationsQueryDto {
	@IsOptional()
	@IsISO8601()
	from?: string;

	@IsOptional()
	@IsISO8601()
	to?: string;

	@IsOptional()
	@IsString()
	clientServiceId?: string;

	@IsOptional()
	@IsString()
	clientServiceSlug?: string;

	@Type(() => Number)
	@IsOptional()
	@IsInt()
	@Min(1)
	minRequests?: number;

	@Type(() => Number)
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number;
}

export type TelemetryHealthResponse = {
	ok: true;
	service: 'telemetry-api';
	checkedAt: string;
};

export type DashboardSummaryResponse = {
	range: { from: string; to: string };
	totalEvents: number;
	totalReads: number;
	totalUploads: number;
	totalResizes: number;
	cacheHitRate: number | null;
	cacheMissRate: number | null;
	failureRate: number | null;
	avgDurationMs: number | null;
	p95DurationMs: number | null;
	totalInputBytes: number;
	totalOutputBytes: number;
};

export type DashboardTimeseriesPoint = {
	bucketStart: string;
	totalEvents: number;
	cacheHits: number;
	cacheMisses: number;
	cacheHitRate: number | null;
	resizeCompleted: number;
	uploadCompleted: number;
	failures: number;
	avgDurationMs: number | null;
	p95DurationMs: number | null;
};

export type DashboardTimeseriesResponse = {
	interval: DashboardInterval;
	points: DashboardTimeseriesPoint[];
};

export type ImageTelemetryEventListItem = Pick<
	ImageTelemetryEventBase,
	| 'eventId'
	| 'eventType'
	| 'occurredAt'
	| 'receivedAt'
	| 'sourceApp'
	| 'environment'
	| 'status'
	| 'clientServiceId'
	| 'clientServiceSlug'
	| 'requestId'
	| 'traceId'
	| 'imageId'
	| 'imageKey'
	| 'path'
	| 'name'
	| 'cacheKey'
	| 'width'
	| 'height'
	| 'format'
	| 'inputBytes'
	| 'outputBytes'
	| 'durationMs'
	| 'errorCode'
	| 'errorMessage'
> & {
	rawPayload?: ImageTelemetryEvent;
};

export type EventsListResponse = {
	items: ImageTelemetryEventListItem[];
	nextCursor?: string;
};

export type ImageLifecycleEventListItem = Pick<
	ImageLifecycleEvent,
	| 'eventId'
	| 'eventType'
	| 'occurredAt'
	| 'sourceApp'
	| 'environment'
	| 'status'
	| 'clientServiceId'
	| 'clientServiceSlug'
	| 'requestId'
	| 'traceId'
	| 'imageId'
	| 'imageKey'
	| 'path'
	| 'name'
	| 'format'
	| 'inputBytes'
	| 'outputBytes'
	| 'durationMs'
	| 'errorCode'
	| 'errorMessage'
> & {
	receivedAt: string;
	rawPayload?: ImageLifecycleEvent;
};

export type LifecycleEventsListResponse = {
	items: ImageLifecycleEventListItem[];
	nextCursor?: string;
};

export type ImageLifecycleEventsResponse = {
	imageKey: string;
	items: ImageLifecycleEventListItem[];
	nextCursor?: string;
};

export type ImageListItem = {
	imageKey: string;
	imageId?: number;
	path: string;
	name: string;
	format?: string;
	totalReads: number;
	totalResizes: number;
	totalCacheHits: number;
	totalCacheMisses: number;
	cacheHitRate: number | null;
	totalFailures: number;
	avgDurationMs: number | null;
	p95DurationMs: number | null;
	lastSeenAt: string;
};

export type ImagesListResponse = {
	items: ImageListItem[];
	nextCursor?: string;
};

export type ImageDetailResponse = ImageListItem & {
	firstSeenAt: string;
	lastUploadedAt?: string;
	lastReadAt?: string;
};

export type ImageEventsResponse = {
	imageKey: string;
	items: ImageTelemetryEventListItem[];
	nextCursor?: string;
};

export type ImageVariantListItem = {
	variantKey: string;
	imageKey: string;
	width?: number;
	height?: number;
	format?: string;
	outputBytes?: number;
	resizeCount: number;
	avgDurationMs: number | null;
	p95DurationMs: number | null;
	lastResizedAt?: string;
};

export type ImageVariantsResponse = {
	imageKey: string;
	items: ImageVariantListItem[];
};

export type ImageResizeRecommendationItem = {
	recommendationKey: string;
	clientServiceId?: string;
	clientServiceSlug?: string;
	width?: number;
	height?: number;
	format?: string;
	requestCount: number;
	imageCount: number;
	avgDurationMs: number | null;
	p95DurationMs: number | null;
	estimatedSavedResizeMs: number;
	totalInputBytes: number;
	totalOutputBytes: number;
	lastRequestedAt: string;
	sampleImageKeys: string[];
	recommended: boolean;
};

export type ImageResizeRecommendationsResponse = {
	threshold: {
		minRequests: number;
	};
	items: ImageResizeRecommendationItem[];
};

export type ClientServiceStatus = 'ACTIVE' | 'DISABLED';
export type ClientServiceLifecycleEventType =
	'image.upload.completed' | 'image.upload.failed';
export type ClientServiceImageResizeMode = 'ON_DEMAND' | 'PRE_GENERATE';
export type ClientServiceImageResizeFormat = 'png' | 'jpeg' | 'webp';

export type ClientServiceKeyItem = {
	id: string;
	clientServiceId: string;
	name?: string;
	keyPrefix: string;
	scopes?: Record<string, unknown>;
	expiresAt?: string;
	revokedAt?: string;
	lastUsedAt?: string;
	createdAt: string;
};

export type ClientServiceLifecycleSubscriptionItem = {
	id: string;
	clientServiceId: string;
	eventType: ClientServiceLifecycleEventType;
	consumerGroup: string;
	isEnabled: boolean;
	description?: string;
	createdAt: string;
	updatedAt: string;
};

export type ClientServiceImageResizeVariantItem = {
	id: string;
	policyId: string;
	width?: number;
	height?: number;
	format: ClientServiceImageResizeFormat;
	isEnabled: boolean;
	description?: string;
	createdAt: string;
	updatedAt: string;
};

export type ClientServiceImageResizePolicyItem = {
	id: string;
	clientServiceId: string;
	mode: ClientServiceImageResizeMode;
	variants: ClientServiceImageResizeVariantItem[];
	createdAt: string;
	updatedAt: string;
};

export type ClientServiceItem = {
	id: string;
	slug: string;
	name: string;
	description?: string;
	owner?: string;
	status: ClientServiceStatus;
	createdAt: string;
	updatedAt: string;
	keyCount: number;
	activeKeyCount: number;
	subscriptionCount: number;
	activeSubscriptionCount: number;
	keys?: ClientServiceKeyItem[];
	lifecycleSubscriptions?: ClientServiceLifecycleSubscriptionItem[];
	imageResizePolicy?: ClientServiceImageResizePolicyItem;
};

export type CreateClientServiceKeyResponse = {
	apiKey: string;
	key: ClientServiceKeyItem;
};
