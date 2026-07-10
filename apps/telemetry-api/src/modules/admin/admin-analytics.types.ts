import type {
	EventFilter,
	ImageFilter,
	ImageVariantSummary,
	TelemetryRange,
	TimeseriesQuery,
} from '../telemetry/telemetry.types';

export type BucketInterval = NonNullable<TimeseriesQuery['interval']>;

export type DashboardAnalyticsQuery = Omit<
	Partial<EventFilter>,
	'cursor' | 'limit'
>;

export interface DashboardSummary {
	range: TelemetryRange;
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
}

export interface TimeseriesPoint {
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
}

export interface TimeseriesResponse {
	interval: BucketInterval;
	points: TimeseriesPoint[];
}

export type TopImageQuery = ImageFilter;

export interface ImageListItem {
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
}

export interface ImageListResponse {
	items: ImageListItem[];
	nextCursor?: string;
}

export interface ImageResizeRecommendationQuery extends Partial<TelemetryRange> {
	clientServiceId?: string;
	clientServiceSlug?: string;
	minRequests?: number;
	limit?: number;
}

export interface ImageResizeRecommendationItem {
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
}

export interface ImageResizeRecommendationResponse {
	threshold: {
		minRequests: number;
	};
	items: ImageResizeRecommendationItem[];
}

export interface AdminAnalyticsRepository {
	getSummary(query: DashboardAnalyticsQuery): Promise<DashboardSummary>;
	getTimeseries(query: TimeseriesQuery): Promise<TimeseriesResponse>;
	listTopImages(query: TopImageQuery): Promise<ImageListResponse>;
	getImage(imageKey: string): Promise<ImageListItem | undefined>;
	listVariants(imageKey: string): Promise<ImageVariantSummary[]>;
	listResizeRecommendations(
		query: ImageResizeRecommendationQuery,
	): Promise<ImageResizeRecommendationResponse>;
}
