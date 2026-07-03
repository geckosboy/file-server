import {
	BadRequestException,
	Inject,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
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

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

type BucketInterval = 'minute' | 'hour' | 'day';

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

export interface EventListResponse {
	items: ImageTelemetryEvent[];
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

@Injectable()
export class AdminQueryService {
	constructor(
		@Inject(TELEMETRY_REPOSITORY)
		private readonly repository: TelemetryRepository,
	) {}

	async getHealth() {
		return {
			ok: true,
			service: 'telemetry-api',
			checkedAt: new Date().toISOString(),
			storage: {
				kind: this.repository.getStorageKind(),
				connected: await this.repository.isConnected(),
			},
			kafka: {
				connected: false,
				consumerLag: null,
			},
			metrics: await this.repository.getMetrics(),
		};
	}

	async getSummary(query: Partial<EventFilter>): Promise<DashboardSummary> {
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
		const interval = query.interval ?? 'hour';
		if (!['minute', 'hour', 'day'].includes(interval)) {
			throw new BadRequestException('interval must be minute, hour, or day');
		}

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

	async listEvents(query: EventFilter): Promise<EventListResponse> {
		const limit = parseLimit(query.limit);
		const cursor = parseCursor(query.cursor);
		const filtered = (await this.eventsForQuery(query)).sort(compareEventsDesc);

		const items = filtered.slice(cursor, cursor + limit);
		const nextCursor =
			cursor + limit < filtered.length ? String(cursor + limit) : undefined;
		return { items, nextCursor };
	}

	async listImages(query: ImageFilter): Promise<ImageListResponse> {
		const limit = parseLimit(query.limit);
		const cursor = parseCursor(query.cursor);
		const order = query.order ?? 'desc';
		const sort = query.sort ?? 'lastSeenAt';
		const events = await this.eventsForQuery({
			from: query.from,
			to: query.to,
			clientServiceId: query.clientServiceId,
			clientServiceSlug: query.clientServiceSlug,
		});
		const imageDurations = this.durationsByImageKey(events);
		const filtered = (await projectAssetSummaries(events))
			.filter((asset) => matchesImageQuery(asset, query.q))
			.map((asset) =>
				toImageListItem(asset, imageDurations.get(asset.imageKey) ?? []),
			)
			.sort((left, right) => compareImages(left, right, sort, order));

		const items = filtered.slice(cursor, cursor + limit);
		const nextCursor =
			cursor + limit < filtered.length ? String(cursor + limit) : undefined;
		return { items, nextCursor };
	}

	async getImage(imageKey: string): Promise<ImageListItem> {
		const image = (
			await this.listImages({ q: imageKey, limit: MAX_LIMIT })
		).items.find((item) => item.imageKey === imageKey);
		if (!image) {
			throw new NotFoundException('image not found');
		}

		return image;
	}

	async listImageEvents(
		imageKey: string,
		query: EventFilter,
	): Promise<EventListResponse> {
		return this.listEvents({ ...query, imageKey });
	}

	async listImageVariants(imageKey: string) {
		return { items: await this.repository.listVariants(imageKey) };
	}

	private async eventsForQuery(query: Partial<EventFilter>) {
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

	private durationsByImageKey(
		events: ImageTelemetryEvent[],
	): Map<string, number[]> {
		const durations = new Map<string, number[]>();
		for (const event of events) {
			if (event.durationMs === undefined) {
				continue;
			}

			durations.set(event.imageKey, [
				...(durations.get(event.imageKey) ?? []),
				event.durationMs,
			]);
		}

		return durations;
	}
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

function parseLimit(limit: number | undefined): number {
	if (limit === undefined) {
		return DEFAULT_LIMIT;
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new BadRequestException('limit must be between 1 and 100');
	}

	return limit;
}

function parseCursor(cursor: string | undefined): number {
	if (cursor === undefined) {
		return 0;
	}
	const parsed = Number(cursor);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new BadRequestException(
			'cursor must be a non-negative integer offset',
		);
	}

	return parsed;
}

function isValidDate(value: string): boolean {
	return Number.isFinite(new Date(value).getTime());
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

function rate(part: number, total: number): number | null {
	return total === 0 ? null : part / total;
}

function sum(
	events: ImageTelemetryEvent[],
	key: 'inputBytes' | 'outputBytes',
): number {
	return events.reduce((total, event) => total + (event[key] ?? 0), 0);
}

function createBuckets(
	range: TelemetryRange,
	interval: BucketInterval,
): Map<string, MutableTimeseriesPoint> {
	const buckets = new Map<string, MutableTimeseriesPoint>();
	const end = new Date(range.to).getTime();
	let current = floorDate(new Date(range.from), interval);

	while (current.getTime() <= end) {
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
	if (interval === 'minute') {
		next.setUTCMinutes(next.getUTCMinutes() + 1);
	}
	if (interval === 'hour') {
		next.setUTCHours(next.getUTCHours() + 1);
	}
	if (interval === 'day') {
		next.setUTCDate(next.getUTCDate() + 1);
	}

	return next;
}

function compareEventsDesc(
	left: ImageTelemetryEvent,
	right: ImageTelemetryEvent,
): number {
	const timeDiff =
		new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
	return timeDiff === 0 ? right.eventId.localeCompare(left.eventId) : timeDiff;
}

function matchesImageQuery(
	asset: ImageAssetSummary,
	query: string | undefined,
): boolean {
	if (!query) {
		return true;
	}

	return [asset.imageKey, asset.path, asset.name]
		.join(' ')
		.toLowerCase()
		.includes(query.toLowerCase());
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
	sort: NonNullable<ImageFilter['sort']>,
	order: NonNullable<ImageFilter['order']>,
): number {
	const multiplier = order === 'asc' ? 1 : -1;
	const leftValue = imageSortValue(left, sort);
	const rightValue = imageSortValue(right, sort);
	const result =
		leftValue === rightValue
			? left.imageKey.localeCompare(right.imageKey)
			: leftValue - rightValue;
	return result * multiplier;
}

function imageSortValue(
	image: ImageListItem,
	sort: NonNullable<ImageFilter['sort']>,
): number {
	if (sort === 'reads') {
		return image.totalReads;
	}
	if (sort === 'resizes') {
		return image.totalResizes;
	}
	if (sort === 'cacheMisses') {
		return image.totalCacheMisses;
	}
	if (sort === 'failures') {
		return image.totalFailures;
	}

	return new Date(image.lastSeenAt).getTime();
}
