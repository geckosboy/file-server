import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
	average,
	percentile,
	projectAssetSummaries,
	TelemetryRepository,
} from '../telemetry/telemetry.repository';
import { TELEMETRY_REPOSITORY } from '../telemetry/telemetry-repository.provider';
import {
	EventFilter,
	ImageAssetSummary,
	ImageFilter,
	ImageTelemetryEvent,
	TelemetryRange,
	TimeseriesQuery,
} from '../telemetry/telemetry.types';
import {
	AdminAnalyticsRepository,
	BucketInterval,
	DashboardAnalyticsQuery,
	DashboardSummary,
	ImageListItem,
	ImageListResponse,
	ImageResizeRecommendationItem,
	ImageResizeRecommendationQuery,
	ImageResizeRecommendationResponse,
	TimeseriesPoint,
	TimeseriesResponse,
} from './admin-analytics.types';
import {
	encodeImageListCursor,
	ImageListCursor,
	ImageSortField,
	ImageSortOrder,
	parseImageListCursor,
} from './image-list-cursor';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const MAX_TIMESERIES_BUCKETS = 10_000;

@Injectable()
export class InMemoryAdminAnalyticsRepository implements AdminAnalyticsRepository {
	constructor(
		@Inject(TELEMETRY_REPOSITORY)
		private readonly repository: TelemetryRepository,
	) {}

	async getSummary(query: DashboardAnalyticsQuery): Promise<DashboardSummary> {
		const range = parseRange(query);
		const events = await this.eventsForQuery({ ...query, ...range });
		const cacheHits = countByType(events, 'image.cache.hit');
		const cacheMisses = countByType(events, 'image.cache.miss');
		const cacheTotal = cacheHits + cacheMisses;
		const failures = events.filter((event) => event.status === 'failed').length;
		const durations = events
			.map((event) => event.durationMs)
			.filter((duration): duration is number => duration !== undefined);

		return {
			range,
			totalEvents: events.length,
			totalReads: cacheTotal + countByType(events, 'image.read.failed'),
			totalUploads: countByType(events, 'image.upload.completed'),
			totalResizes: countByType(events, 'image.resize.completed'),
			cacheHitRate: rate(cacheHits, cacheTotal),
			cacheMissRate: rate(cacheMisses, cacheTotal),
			failureRate: rate(failures, events.length),
			avgDurationMs: average(durations),
			p95DurationMs: percentile(durations, 0.95),
			totalInputBytes: sum(events, 'inputBytes'),
			totalOutputBytes: sum(events, 'outputBytes'),
		};
	}

	async getTimeseries(query: TimeseriesQuery): Promise<TimeseriesResponse> {
		const interval = parseInterval(query.interval);
		const now = new Date();
		const range = parseRange({
			from:
				query.from ??
				new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
			to: query.to ?? now.toISOString(),
		});
		const buckets = createBuckets(range, interval);
		const events = await this.eventsForQuery({ ...query, ...range });
		for (const event of events) {
			const bucketStart = floorDate(
				new Date(event.occurredAt),
				interval,
			).toISOString();
			const bucket = buckets.get(bucketStart);
			if (!bucket) {
				continue;
			}

			bucket.totalEvents += 1;
			bucket.cacheHits += event.eventType === 'image.cache.hit' ? 1 : 0;
			bucket.cacheMisses += event.eventType === 'image.cache.miss' ? 1 : 0;
			bucket.resizeCompleted +=
				event.eventType === 'image.resize.completed' ? 1 : 0;
			bucket.uploadCompleted +=
				event.eventType === 'image.upload.completed' ? 1 : 0;
			bucket.failures += event.status === 'failed' ? 1 : 0;
			if (event.durationMs !== undefined) {
				bucket.durations.push(event.durationMs);
			}
		}

		return {
			interval,
			points: [...buckets.values()].map(({ durations, ...bucket }) => ({
				...bucket,
				cacheHitRate: rate(
					bucket.cacheHits,
					bucket.cacheHits + bucket.cacheMisses,
				),
				avgDurationMs: average(durations),
				p95DurationMs: percentile(durations, 0.95),
			})),
		};
	}

	async listTopImages(query: ImageFilter): Promise<ImageListResponse> {
		const limit = parseLimit(query.limit);
		const order = query.order ?? 'desc';
		const sort = query.sort ?? 'lastSeenAt';
		const parsedCursor = parseImageListCursor(query.cursor, sort, order);
		const events = await this.eventsForQuery({
			from: query.from,
			to: query.to,
			clientServiceId: query.clientServiceId,
			clientServiceSlug: query.clientServiceSlug,
		});
		const imageDurations = durationsByImageKey(events);
		const filtered = (await projectAssetSummaries(events))
			.filter((asset) => matchesImageQuery(asset, query.q))
			.map((asset) =>
				toImageListItem(asset, imageDurations.get(asset.imageKey) ?? []),
			)
			.filter((item) => isAfterCursor(item, parsedCursor.cursor))
			.sort((left, right) => compareImages(left, right, sort, order));
		const offset = parsedCursor.offset ?? 0;
		const rows = filtered.slice(offset, offset + limit + 1);
		const items = rows.slice(0, limit);
		const lastItem = items.at(-1);

		return {
			items,
			nextCursor:
				rows.length > limit && lastItem
					? encodeImageListCursor(toImageCursor(lastItem, sort, order))
					: undefined,
		};
	}

	async getImage(imageKey: string): Promise<ImageListItem | undefined> {
		const events = await this.eventsForQuery({ imageKey });
		const asset = (await projectAssetSummaries(events))[0];
		if (!asset) {
			return undefined;
		}

		return toImageListItem(
			asset,
			durationsByImageKey(events).get(imageKey) ?? [],
		);
	}

	async listVariants(imageKey: string) {
		return this.repository.listVariants(imageKey);
	}

	async listResizeRecommendations(
		query: ImageResizeRecommendationQuery,
	): Promise<ImageResizeRecommendationResponse> {
		const limit = parseLimit(query.limit);
		const minRequests = parseMinRequests(query.minRequests);
		const events = await this.eventsForQuery({
			from: query.from,
			to: query.to,
			clientServiceId: query.clientServiceId,
			clientServiceSlug: query.clientServiceSlug,
			eventType: 'image.resize.completed',
			status: 'success',
		});
		const grouped = new Map<string, MutableImageResizeRecommendation>();

		for (const event of events) {
			if (!isOnDemandResizeEvent(event)) {
				continue;
			}

			const key = createResizeRecommendationKey(event);
			const current =
				grouped.get(key) ?? createMutableImageResizeRecommendation(key, event);
			current.requestCount += 1;
			current.totalInputBytes += event.inputBytes ?? 0;
			current.totalOutputBytes += event.outputBytes ?? 0;
			current.lastRequestedAt = maxIso(
				current.lastRequestedAt,
				event.occurredAt,
			);
			current.imageKeys.add(event.imageKey);
			if (current.sampleImageKeys.length < 5) {
				current.sampleImageKeys.push(event.imageKey);
			}
			if (event.durationMs !== undefined) {
				current.durations.push(event.durationMs);
			}

			grouped.set(key, current);
		}

		return {
			threshold: { minRequests },
			items: [...grouped.values()]
				.map((item) => toImageResizeRecommendationItem(item, { minRequests }))
				.sort(compareImageResizeRecommendations)
				.slice(0, limit),
		};
	}

	private async eventsForQuery(
		query: Partial<EventFilter>,
	): Promise<ImageTelemetryEvent[]> {
		const range = parseRange(query, true);
		return (await this.repository.listEvents())
			.filter((event) => matchesOptionalRange(event.occurredAt, range))
			.filter(
				(event) => !query.eventType || event.eventType === query.eventType,
			)
			.filter(
				(event) => !query.sourceApp || event.sourceApp === query.sourceApp,
			)
			.filter((event) => !query.status || event.status === query.status)
			.filter(
				(event) =>
					!query.clientServiceId ||
					event.clientServiceId === query.clientServiceId,
			)
			.filter(
				(event) =>
					!query.clientServiceSlug ||
					event.clientServiceSlug === query.clientServiceSlug,
			)
			.filter((event) => !query.path || event.path.includes(query.path))
			.filter((event) => !query.name || event.name.includes(query.name))
			.filter((event) => !query.imageKey || event.imageKey === query.imageKey)
			.filter(
				(event) => !query.requestId || event.requestId === query.requestId,
			);
	}
}

interface MutableImageResizeRecommendation {
	recommendationKey: string;
	clientServiceId?: string;
	clientServiceSlug?: string;
	width?: number;
	height?: number;
	format?: string;
	requestCount: number;
	totalInputBytes: number;
	totalOutputBytes: number;
	lastRequestedAt: string;
	imageKeys: Set<string>;
	sampleImageKeys: string[];
	durations: number[];
}

interface MutableTimeseriesPoint extends Omit<
	TimeseriesPoint,
	'cacheHitRate' | 'avgDurationMs' | 'p95DurationMs'
> {
	durations: number[];
}

function parseRange(
	query: Partial<TelemetryRange>,
	optional = false,
): TelemetryRange {
	const now = new Date();
	const from =
		query.from ?? (optional ? undefined : '1970-01-01T00:00:00.000Z');
	const to = query.to ?? (optional ? undefined : now.toISOString());

	if (from && !isValidDate(from)) {
		throw new BadRequestException('from and to must be ISO date strings');
	}
	if (to && !isValidDate(to)) {
		throw new BadRequestException('from and to must be ISO date strings');
	}
	if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
		throw new BadRequestException('from must be earlier than to');
	}

	return { from: from ?? '', to: to ?? '' };
}

function parseInterval(interval: string | undefined): BucketInterval {
	const parsed = interval ?? 'hour';
	if (!['minute', 'hour', 'day'].includes(parsed)) {
		throw new BadRequestException('interval must be minute, hour, or day');
	}
	return parsed as BucketInterval;
}

function parseLimit(limit: number | undefined): number {
	if (limit === undefined) {
		return DEFAULT_LIMIT;
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new BadRequestException('limit must be between 1 and 100');
	}
	return limit;
}

function parseMinRequests(minRequests: number | undefined): number {
	if (minRequests === undefined) {
		return 3;
	}
	if (!Number.isInteger(minRequests) || minRequests < 1) {
		throw new BadRequestException('minRequests must be a positive integer');
	}
	return minRequests;
}

function createBuckets(
	range: TelemetryRange,
	interval: BucketInterval,
): Map<string, MutableTimeseriesPoint> {
	const buckets = new Map<string, MutableTimeseriesPoint>();
	const end = new Date(range.to).getTime();
	let current = floorDate(new Date(range.from), interval);
	let count = 0;

	while (current.getTime() <= end) {
		count += 1;
		if (count > MAX_TIMESERIES_BUCKETS) {
			throw new BadRequestException(
				`timeseries range must produce at most ${MAX_TIMESERIES_BUCKETS} buckets`,
			);
		}
		const bucketStart = current.toISOString();
		buckets.set(bucketStart, {
			bucketStart,
			totalEvents: 0,
			cacheHits: 0,
			cacheMisses: 0,
			resizeCompleted: 0,
			uploadCompleted: 0,
			failures: 0,
			durations: [],
		});
		current = addInterval(current, interval);
	}

	return buckets;
}

function floorDate(date: Date, interval: BucketInterval): Date {
	const next = new Date(date);
	next.setUTCSeconds(0, 0);
	if (interval === 'hour' || interval === 'day') {
		next.setUTCMinutes(0, 0, 0);
	}
	if (interval === 'day') {
		next.setUTCHours(0, 0, 0, 0);
	}
	return next;
}

function addInterval(date: Date, interval: BucketInterval): Date {
	const next = new Date(date);
	if (interval === 'minute') next.setUTCMinutes(next.getUTCMinutes() + 1);
	if (interval === 'hour') next.setUTCHours(next.getUTCHours() + 1);
	if (interval === 'day') next.setUTCDate(next.getUTCDate() + 1);
	return next;
}

function durationsByImageKey(
	events: ImageTelemetryEvent[],
): Map<string, number[]> {
	const durations = new Map<string, number[]>();
	for (const event of events) {
		if (event.durationMs !== undefined) {
			durations.set(event.imageKey, [
				...(durations.get(event.imageKey) ?? []),
				event.durationMs,
			]);
		}
	}
	return durations;
}

function matchesImageQuery(
	asset: ImageAssetSummary,
	query: string | undefined,
): boolean {
	return query
		? [asset.imageKey, asset.path, asset.name]
				.join(' ')
				.toLowerCase()
				.includes(query.toLowerCase())
		: true;
}

function toImageListItem(
	asset: ImageAssetSummary,
	durations: number[],
): ImageListItem {
	const cacheTotal = asset.totalCacheHits + asset.totalCacheMisses;
	return {
		imageKey: asset.imageKey,
		imageId: asset.imageId,
		path: asset.path,
		name: asset.name,
		format: asset.format,
		totalReads: asset.totalReads,
		totalResizes: asset.totalResizes,
		totalCacheHits: asset.totalCacheHits,
		totalCacheMisses: asset.totalCacheMisses,
		cacheHitRate: rate(asset.totalCacheHits, cacheTotal),
		totalFailures: asset.totalFailures,
		avgDurationMs: average(durations),
		p95DurationMs: percentile(durations, 0.95),
		lastSeenAt: asset.lastSeenAt,
	};
}

function compareImages(
	left: ImageListItem,
	right: ImageListItem,
	sort: ImageSortField,
	order: ImageSortOrder,
): number {
	const leftValue = imageSortValue(left, sort);
	const rightValue = imageSortValue(right, sort);
	const ascending =
		leftValue === rightValue
			? left.imageKey.localeCompare(right.imageKey)
			: leftValue < rightValue
				? -1
				: 1;
	return order === 'asc' ? ascending : -ascending;
}

function isAfterCursor(
	item: ImageListItem,
	cursor: ImageListCursor | undefined,
): boolean {
	if (!cursor) return true;
	const itemValue = imageSortValue(item, cursor.sort);
	const cursorValue =
		cursor.sort === 'lastSeenAt'
			? new Date(String(cursor.sortValue)).getTime()
			: Number(cursor.sortValue);
	const ascending =
		itemValue === cursorValue
			? item.imageKey.localeCompare(cursor.imageKey)
			: itemValue < cursorValue
				? -1
				: 1;
	return cursor.order === 'asc' ? ascending > 0 : ascending < 0;
}

function toImageCursor(
	item: ImageListItem,
	sort: ImageSortField,
	order: ImageSortOrder,
): ImageListCursor {
	return {
		sort,
		order,
		sortValue:
			sort === 'lastSeenAt' ? item.lastSeenAt : imageSortValue(item, sort),
		imageKey: item.imageKey,
	};
}

function imageSortValue(item: ImageListItem, sort: ImageSortField): number {
	if (sort === 'reads') return item.totalReads;
	if (sort === 'resizes') return item.totalResizes;
	if (sort === 'cacheMisses') return item.totalCacheMisses;
	if (sort === 'failures') return item.totalFailures;
	return new Date(item.lastSeenAt).getTime();
}

function isOnDemandResizeEvent(event: ImageTelemetryEvent): boolean {
	return (
		event.eventType === 'image.resize.completed' &&
		event.status === 'success' &&
		(event.clientServiceId !== undefined ||
			event.clientServiceSlug !== undefined) &&
		(event.width !== undefined || event.height !== undefined) &&
		event.cacheKey === undefined
	);
}

function createResizeRecommendationKey(event: ImageTelemetryEvent): string {
	return [
		event.clientServiceId ?? 'unknown-id',
		event.clientServiceSlug ?? 'unknown-slug',
		event.width ?? 'auto',
		event.height ?? 'auto',
		event.format ?? 'unknown',
	].join(':');
}

function createMutableImageResizeRecommendation(
	recommendationKey: string,
	event: ImageTelemetryEvent,
): MutableImageResizeRecommendation {
	return {
		recommendationKey,
		clientServiceId: event.clientServiceId,
		clientServiceSlug: event.clientServiceSlug,
		width: event.width,
		height: event.height,
		format: event.format,
		requestCount: 0,
		totalInputBytes: 0,
		totalOutputBytes: 0,
		lastRequestedAt: event.occurredAt,
		imageKeys: new Set<string>(),
		sampleImageKeys: [],
		durations: [],
	};
}

function toImageResizeRecommendationItem(
	item: MutableImageResizeRecommendation,
	threshold: { minRequests: number },
): ImageResizeRecommendationItem {
	return {
		recommendationKey: item.recommendationKey,
		clientServiceId: item.clientServiceId,
		clientServiceSlug: item.clientServiceSlug,
		width: item.width,
		height: item.height,
		format: item.format,
		requestCount: item.requestCount,
		imageCount: item.imageKeys.size,
		avgDurationMs: average(item.durations),
		p95DurationMs: percentile(item.durations, 0.95),
		estimatedSavedResizeMs: item.durations.reduce(
			(total, duration) => total + duration,
			0,
		),
		totalInputBytes: item.totalInputBytes,
		totalOutputBytes: item.totalOutputBytes,
		lastRequestedAt: item.lastRequestedAt,
		sampleImageKeys: [...new Set(item.sampleImageKeys)],
		recommended: item.requestCount >= threshold.minRequests,
	};
}

function compareImageResizeRecommendations(
	left: ImageResizeRecommendationItem,
	right: ImageResizeRecommendationItem,
): number {
	if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
	if (left.requestCount !== right.requestCount)
		return right.requestCount - left.requestCount;
	if (left.estimatedSavedResizeMs !== right.estimatedSavedResizeMs)
		return right.estimatedSavedResizeMs - left.estimatedSavedResizeMs;
	const timeDiff =
		new Date(right.lastRequestedAt).getTime() -
		new Date(left.lastRequestedAt).getTime();
	return timeDiff === 0
		? left.recommendationKey.localeCompare(right.recommendationKey)
		: timeDiff;
}

function matchesOptionalRange(
	date: string,
	range: Partial<TelemetryRange>,
): boolean {
	return (
		(!range.from ||
			new Date(date).getTime() >= new Date(range.from).getTime()) &&
		(!range.to || new Date(date).getTime() <= new Date(range.to).getTime())
	);
}

function countByType(events: ImageTelemetryEvent[], eventType: string): number {
	return events.filter((event) => event.eventType === eventType).length;
}

function sum(
	events: ImageTelemetryEvent[],
	key: 'inputBytes' | 'outputBytes',
): number {
	return events.reduce((total, event) => total + (event[key] ?? 0), 0);
}

function rate(part: number, total: number): number | null {
	return total === 0 ? null : part / total;
}

function isValidDate(value: string): boolean {
	return Number.isFinite(new Date(value).getTime());
}

function maxIso(left: string, right: string): string {
	return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}
