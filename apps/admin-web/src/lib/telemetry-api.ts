export type SourceApp = 'storage' | 'resize' | 'cache';
export type EventStatus = 'success' | 'failed';
export type LifecycleEventType =
	'image.upload.completed' | 'image.upload.failed';
export type ClientServiceStatus = 'ACTIVE' | 'DISABLED';
export type ImageResizeMode = 'ON_DEMAND' | 'PRE_GENERATE';
export type ImageResizeFormat = 'png' | 'jpeg' | 'webp';

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
	receivedAt?: string;
	sourceApp: SourceApp;
	environment?: string;
	status: EventStatus;
	clientServiceId?: string;
	clientServiceSlug?: string;
	path: string;
	name: string;
	imageKey: string;
	width?: number;
	height?: number;
	durationMs?: number;
	inputBytes?: number;
	outputBytes?: number;
	requestId?: string;
	traceId?: string;
	errorCode?: string;
	errorMessage?: string;
	rawPayload: Record<string, unknown>;
}

export interface EventListResponse {
	items: EventListItem[];
	nextCursor?: string;
}

export interface LifecycleEventListItem {
	eventId: string;
	eventType: LifecycleEventType;
	occurredAt: string;
	receivedAt?: string;
	sourceApp: 'storage';
	environment?: string;
	status: EventStatus;
	clientServiceId?: string;
	clientServiceSlug?: string;
	requestId?: string;
	traceId?: string;
	imageId?: number;
	path: string;
	name: string;
	imageKey: string;
	format?: string;
	durationMs?: number;
	inputBytes?: number;
	outputBytes?: number;
	errorCode?: string;
	errorMessage?: string;
	rawPayload: Record<string, unknown>;
}

export interface LifecycleEventListResponse {
	items: LifecycleEventListItem[];
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

export interface ClientServiceKeyItem {
	id: string;
	clientServiceId: string;
	name?: string;
	keyPrefix: string;
	scopes?: Record<string, unknown>;
	expiresAt?: string;
	revokedAt?: string;
	lastUsedAt?: string;
	createdAt: string;
}

export interface ClientServiceLifecycleSubscriptionItem {
	id: string;
	clientServiceId: string;
	eventType: LifecycleEventType;
	consumerGroup: string;
	isEnabled: boolean;
	description?: string;
	createdAt: string;
	updatedAt: string;
}

export interface ClientServiceImageResizeVariantItem {
	id: string;
	policyId: string;
	width?: number;
	height?: number;
	format: ImageResizeFormat;
	isEnabled: boolean;
	description?: string;
	createdAt: string;
	updatedAt: string;
}

export interface ClientServiceImageResizePolicyItem {
	id: string;
	clientServiceId: string;
	mode: ImageResizeMode;
	variants: ClientServiceImageResizeVariantItem[];
	createdAt: string;
	updatedAt: string;
}

export interface ClientServiceItem {
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
}

export interface CreateClientServiceInput {
	slug: string;
	name: string;
	description?: string;
	owner?: string;
	status?: ClientServiceStatus;
}

export interface UpdateClientServiceInput {
	slug?: string;
	name?: string;
	description?: string | null;
	owner?: string | null;
	status?: ClientServiceStatus;
}

export interface CreateClientServiceKeyInput {
	name?: string;
	scopes?: Record<string, unknown>;
	expiresAt?: string;
}

export interface CreateClientServiceLifecycleSubscriptionInput {
	eventType: LifecycleEventType;
	consumerGroup: string;
	isEnabled?: boolean;
	description?: string;
}

export interface UpdateClientServiceLifecycleSubscriptionInput {
	eventType?: LifecycleEventType;
	consumerGroup?: string;
	isEnabled?: boolean;
	description?: string | null;
}

export interface UpdateClientServiceImageResizePolicyInput {
	mode: ImageResizeMode;
}

export interface CreateClientServiceImageResizeVariantInput {
	width?: number;
	height?: number;
	format: ImageResizeFormat;
	isEnabled?: boolean;
	description?: string;
}

export interface UpdateClientServiceImageResizeVariantInput {
	width?: number;
	height?: number;
	format?: ImageResizeFormat;
	isEnabled?: boolean;
	description?: string | null;
}

export interface CreateClientServiceKeyResponse {
	apiKey: string;
	key: ClientServiceKeyItem;
}

export interface ServiceScopedQuery extends Partial<TimeRange> {
	clientServiceId?: string;
	clientServiceSlug?: string;
}

export interface DashboardQuery extends ServiceScopedQuery {
	interval?: 'minute' | 'hour' | 'day';
}

export interface EventsQuery extends ServiceScopedQuery {
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

export interface LifecycleEventsQuery extends ServiceScopedQuery {
	eventType?: LifecycleEventType;
	status?: EventStatus;
	imageKey?: string;
	requestId?: string;
	cursor?: string;
	limit?: number;
}

export interface ImagesQuery extends ServiceScopedQuery {
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

export const getTelemetryAdminToken = () => process.env.TELEMETRY_ADMIN_TOKEN;

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

const serviceScopedParams = (query: ServiceScopedQuery) => ({
	from: query.from,
	to: query.to,
	clientServiceId: query.clientServiceId,
	clientServiceSlug: query.clientServiceSlug,
});

export const buildDashboardSummaryUrl = (
	query: DashboardQuery = {},
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	appendDefinedParams(createAdminUrl(baseUrl, '/dashboard/summary'), {
		...serviceScopedParams(query),
	}).toString();

export const buildDashboardTimeseriesUrl = (
	query: DashboardQuery = {},
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	appendDefinedParams(createAdminUrl(baseUrl, '/dashboard/timeseries'), {
		...serviceScopedParams(query),
		interval: query.interval,
	}).toString();

export const buildEventsUrl = (
	query: EventsQuery = {},
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	appendDefinedParams(createAdminUrl(baseUrl, '/events'), {
		...serviceScopedParams(query),
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

export const buildLifecycleEventsUrl = (
	query: LifecycleEventsQuery = {},
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	appendDefinedParams(createAdminUrl(baseUrl, '/lifecycle-events'), {
		...serviceScopedParams(query),
		eventType: query.eventType,
		status: query.status,
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
		...serviceScopedParams(query),
		q: query.q,
		sort: query.sort,
		order: query.order,
		cursor: query.cursor,
		limit: query.limit,
	}).toString();

export const buildClientServicesUrl = (baseUrl = getTelemetryApiBaseUrl()) =>
	createAdminUrl(baseUrl, '/client-services').toString();

export const buildClientServiceUrl = (
	id: string,
	baseUrl = getTelemetryApiBaseUrl(),
) => createAdminUrl(baseUrl, `/client-services/${id}`).toString();

export const buildClientServiceKeysUrl = (
	id: string,
	baseUrl = getTelemetryApiBaseUrl(),
) => createAdminUrl(baseUrl, `/client-services/${id}/keys`).toString();

export const buildClientServiceKeyRevokeUrl = (
	serviceId: string,
	keyId: string,
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	createAdminUrl(
		baseUrl,
		`/client-services/${serviceId}/keys/${keyId}/revoke`,
	).toString();

export const buildClientServiceLifecycleSubscriptionsUrl = (
	serviceId: string,
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	createAdminUrl(
		baseUrl,
		`/client-services/${serviceId}/lifecycle-subscriptions`,
	).toString();

export const buildClientServiceLifecycleSubscriptionUrl = (
	serviceId: string,
	subscriptionId: string,
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	createAdminUrl(
		baseUrl,
		`/client-services/${serviceId}/lifecycle-subscriptions/${subscriptionId}`,
	).toString();

export const buildClientServiceImageResizePolicyUrl = (
	serviceId: string,
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	createAdminUrl(
		baseUrl,
		`/client-services/${serviceId}/image-resize-policy`,
	).toString();

export const buildClientServiceImageResizeVariantsUrl = (
	serviceId: string,
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	createAdminUrl(
		baseUrl,
		`/client-services/${serviceId}/image-resize-policy/variants`,
	).toString();

export const buildClientServiceImageResizeVariantUrl = (
	serviceId: string,
	variantId: string,
	baseUrl = getTelemetryApiBaseUrl(),
) =>
	createAdminUrl(
		baseUrl,
		`/client-services/${serviceId}/image-resize-policy/variants/${variantId}`,
	).toString();

export const fetchTelemetryJson = async <T>(
	url: string,
	init: RequestInit = {},
): Promise<T> => {
	const adminToken = getTelemetryAdminToken();
	const headers = new Headers(init.headers);
	headers.set('accept', 'application/json');
	if (init.body && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	if (adminToken) {
		headers.set('x-admin-token', adminToken);
	}

	const response = await fetch(url, {
		...init,
		headers,
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

const writeTelemetryJson = <T>(
	url: string,
	method: 'POST' | 'PATCH' | 'DELETE',
	payload?: unknown,
) =>
	fetchTelemetryJson<T>(url, {
		method,
		body: payload === undefined ? undefined : JSON.stringify(payload),
	});

export const fetchDashboardSummary = (query: DashboardQuery = {}) =>
	fetchTelemetryJson<DashboardSummary>(buildDashboardSummaryUrl(query));

export const fetchDashboardTimeseries = (query: DashboardQuery = {}) =>
	fetchTelemetryJson<{ interval: string; points: TimeseriesPoint[] }>(
		buildDashboardTimeseriesUrl(query),
	);

export const fetchEvents = (query: EventsQuery = {}) =>
	fetchTelemetryJson<EventListResponse>(buildEventsUrl(query));

export const fetchLifecycleEvents = (query: LifecycleEventsQuery = {}) =>
	fetchTelemetryJson<LifecycleEventListResponse>(
		buildLifecycleEventsUrl(query),
	);

export const fetchImages = (query: ImagesQuery = {}) =>
	fetchTelemetryJson<ImageListResponse>(buildImagesUrl(query));

export const fetchClientServices = () =>
	fetchTelemetryJson<ClientServiceItem[]>(buildClientServicesUrl());

export const fetchClientService = (id: string) =>
	fetchTelemetryJson<ClientServiceItem>(buildClientServiceUrl(id));

export const fetchClientServiceDetailsList = async () => {
	const services = await fetchClientServices();
	return await Promise.all(
		services.map(async (service) => {
			const [detail, imageResizePolicy] = await Promise.all([
				fetchClientService(service.id),
				fetchClientServiceImageResizePolicy(service.id),
			]);

			return { ...detail, imageResizePolicy };
		}),
	);
};

export const createClientService = (input: CreateClientServiceInput) =>
	writeTelemetryJson<ClientServiceItem>(
		buildClientServicesUrl(),
		'POST',
		input,
	);

export const updateClientService = (
	id: string,
	input: UpdateClientServiceInput,
) =>
	writeTelemetryJson<ClientServiceItem>(
		buildClientServiceUrl(id),
		'PATCH',
		input,
	);

export const createClientServiceKey = (
	id: string,
	input: CreateClientServiceKeyInput,
) =>
	writeTelemetryJson<CreateClientServiceKeyResponse>(
		buildClientServiceKeysUrl(id),
		'POST',
		input,
	);

export const revokeClientServiceKey = (serviceId: string, keyId: string) =>
	writeTelemetryJson<ClientServiceKeyItem>(
		buildClientServiceKeyRevokeUrl(serviceId, keyId),
		'POST',
	);

export const createClientServiceLifecycleSubscription = (
	serviceId: string,
	input: CreateClientServiceLifecycleSubscriptionInput,
) =>
	writeTelemetryJson<ClientServiceLifecycleSubscriptionItem>(
		buildClientServiceLifecycleSubscriptionsUrl(serviceId),
		'POST',
		input,
	);

export const updateClientServiceLifecycleSubscription = (
	serviceId: string,
	subscriptionId: string,
	input: UpdateClientServiceLifecycleSubscriptionInput,
) =>
	writeTelemetryJson<ClientServiceLifecycleSubscriptionItem>(
		buildClientServiceLifecycleSubscriptionUrl(serviceId, subscriptionId),
		'PATCH',
		input,
	);

export const fetchClientServiceImageResizePolicy = (serviceId: string) =>
	fetchTelemetryJson<ClientServiceImageResizePolicyItem>(
		buildClientServiceImageResizePolicyUrl(serviceId),
	);

export const updateClientServiceImageResizePolicy = (
	serviceId: string,
	input: UpdateClientServiceImageResizePolicyInput,
) =>
	writeTelemetryJson<ClientServiceImageResizePolicyItem>(
		buildClientServiceImageResizePolicyUrl(serviceId),
		'PATCH',
		input,
	);

export const createClientServiceImageResizeVariant = (
	serviceId: string,
	input: CreateClientServiceImageResizeVariantInput,
) =>
	writeTelemetryJson<ClientServiceImageResizeVariantItem>(
		buildClientServiceImageResizeVariantsUrl(serviceId),
		'POST',
		input,
	);

export const updateClientServiceImageResizeVariant = (
	serviceId: string,
	variantId: string,
	input: UpdateClientServiceImageResizeVariantInput,
) =>
	writeTelemetryJson<ClientServiceImageResizeVariantItem>(
		buildClientServiceImageResizeVariantUrl(serviceId, variantId),
		'PATCH',
		input,
	);

export const deleteClientServiceImageResizeVariant = (
	serviceId: string,
	variantId: string,
) =>
	writeTelemetryJson<ClientServiceImageResizeVariantItem>(
		buildClientServiceImageResizeVariantUrl(serviceId, variantId),
		'DELETE',
	);

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
