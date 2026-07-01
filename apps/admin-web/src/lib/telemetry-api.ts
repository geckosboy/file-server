export type SourceApp = 'storage' | 'resize' | 'cache';
export type EventStatus = 'success' | 'failed';

export interface TimeRange {
	from: string;
	to: string;
}

export interface DashboardSummary {
	range: TimeRange;
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

export interface DashboardData {
	summary: DashboardSummary;
	timeseries: TimeseriesPoint[];
	topImages: ImageListItem[];
}

export interface EventListItem {
	eventId: string;
	eventType: string;
	occurredAt: string;
	sourceApp: SourceApp;
	status: EventStatus;
	path: string;
	name: string;
	imageKey: string;
	width?: number;
	height?: number;
	durationMs?: number;
	inputBytes?: number;
	outputBytes?: number;
	requestId?: string;
	errorCode?: string;
	errorMessage?: string;
	rawPayload: Record<string, unknown>;
}

export interface EventListResponse {
	items: EventListItem[];
	nextCursor?: string;
}

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

export interface DashboardQuery extends Partial<TimeRange> {
	interval?: 'minute' | 'hour' | 'day';
}

export interface EventsQuery extends Partial<TimeRange> {
	eventType?: string;
	sourceApp?: SourceApp;
	status?: EventStatus;
	path?: string;
	name?: string;
	imageKey?: string;
	requestId?: string;
	cursor?: string;
	limit?: number;
}

export interface ImagesQuery extends Partial<TimeRange> {
	q?: string;
	sort?: 'reads' | 'resizes' | 'cacheMisses' | 'failures' | 'lastSeenAt';
	order?: 'asc' | 'desc';
	cursor?: string;
	limit?: number;
}

export class TelemetryApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly statusText: string,
	) {
		super(message);
		this.name = 'TelemetryApiError';
	}
}

const DEFAULT_ADMIN_API_BASE_URL = 'http://localhost:3001/api/admin';

export const getTelemetryApiBaseUrl = () =>
	process.env.NEXT_PUBLIC_TELEMETRY_API_BASE_URL ||
	process.env.TELEMETRY_API_BASE_URL ||
	DEFAULT_ADMIN_API_BASE_URL;

export const getTelemetryAdminToken = () =>
	process.env.TELEMETRY_ADMIN_TOKEN ||
	process.env.NEXT_PUBLIC_TELEMETRY_ADMIN_TOKEN;

const createAdminUrl = (baseUrl: string, path: string) =>
	new URL(`${baseUrl.replace(/\/$/, '')}${path}`);

const appendDefinedParams = (
	url: URL,
	params: Record<string, string | number | undefined>,
) => {
	Object.entries(params).forEach(([key, value]) => {
		if (value !== undefined && value !== '') {
			url.searchParams.set(key, String(value));
		}
	});

	return url;
};

export const buildDashboardSummaryUrl = (
	query: DashboardQuery = {},
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	appendDefinedParams(createAdminUrl(baseUrl, '/dashboard/summary'), {
		from: query.from,
		to: query.to,
	}).toString();

export const buildDashboardTimeseriesUrl = (
	query: DashboardQuery = {},
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	appendDefinedParams(createAdminUrl(baseUrl, '/dashboard/timeseries'), {
		from: query.from,
		to: query.to,
		interval: query.interval,
	}).toString();

export const buildEventsUrl = (
	query: EventsQuery = {},
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	appendDefinedParams(createAdminUrl(baseUrl, '/events'), {
		from: query.from,
		to: query.to,
		eventType: query.eventType,
		sourceApp: query.sourceApp,
		status: query.status,
		path: query.path,
		name: query.name,
		imageKey: query.imageKey,
		requestId: query.requestId,
		cursor: query.cursor,
		limit: query.limit,
	}).toString();

export const buildImagesUrl = (
	query: ImagesQuery = {},
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	appendDefinedParams(createAdminUrl(baseUrl, '/images'), {
		from: query.from,
		to: query.to,
		q: query.q,
		sort: query.sort,
		order: query.order,
		cursor: query.cursor,
		limit: query.limit,
	}).toString();

export const fetchTelemetryJson = async <T>(url: string): Promise<T> => {
	const adminToken = getTelemetryAdminToken();
	const response = await fetch(url, {
		headers: {
			accept: 'application/json',
			...(adminToken ? { 'x-admin-token': adminToken } : {}),
		},
		cache: 'no-store',
	});

	if (!response.ok) {
		throw new TelemetryApiError(
			`telemetry-api 요청 실패: ${response.status}`,
			response.status,
			response.statusText,
		);
	}

	return (await response.json()) as T;
};

export const fetchDashboardSummary = (query: DashboardQuery = {}) =>
	fetchTelemetryJson<DashboardSummary>(buildDashboardSummaryUrl(query));

export const fetchDashboardTimeseries = (query: DashboardQuery = {}) =>
	fetchTelemetryJson<{ interval: string; points: TimeseriesPoint[] }>(
		buildDashboardTimeseriesUrl(query),
	);

export const fetchEvents = (query: EventsQuery = {}) =>
	fetchTelemetryJson<EventListResponse>(buildEventsUrl(query));

export const fetchImages = (query: ImagesQuery = {}) =>
	fetchTelemetryJson<ImageListResponse>(buildImagesUrl(query));

export const toMetricDisplay = (
	value: number | null | undefined,
	options: { suffix?: string; fractionDigits?: number; fallback?: string } = {},
) => {
	if (value === null || value === undefined || Number.isNaN(value)) {
		return options.fallback ?? '데이터 없음';
	}

	const fractionDigits = options.fractionDigits ?? 0;
	return `${value.toLocaleString('ko-KR', {
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits: fractionDigits,
	})}${options.suffix ?? ''}`;
};
