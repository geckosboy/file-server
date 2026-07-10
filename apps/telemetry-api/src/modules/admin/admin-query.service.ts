import {
	BadRequestException,
	Inject,
	Injectable,
	NotFoundException,
	Optional,
} from '@nestjs/common';
import { TelemetryRepository } from '../telemetry/telemetry.repository';
import { TelemetryKafkaConsumerStatusService } from '../kafka-ingestion/kafka-ingestion.status';
import { LifecycleKafkaConsumerStatusService } from '../kafka-lifecycle/kafka-lifecycle.status';
import { LIFECYCLE_REPOSITORY } from '../lifecycle/lifecycle-repository.provider';
import { LifecycleRepository } from '../lifecycle/lifecycle.repository';
import {
	ImageLifecycleEvent,
	LifecycleEventFilter,
} from '../lifecycle/lifecycle.types';
import { TELEMETRY_REPOSITORY } from '../telemetry/telemetry-repository.provider';
import {
	EventFilter,
	ImageFilter,
	ImageTelemetryEvent,
	TelemetryRange,
	TimeseriesQuery,
} from '../telemetry/telemetry.types';
import { EventListQuery } from '../telemetry/event-list-query';
import {
	encodeEventListCursor,
	parseEventListCursor,
} from './event-list-cursor';
import { AdminAnalyticsRepository } from './admin-analytics.types';
import { ADMIN_ANALYTICS_REPOSITORY } from './admin-analytics.provider';

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

export interface LifecycleEventListResponse {
	items: ImageLifecycleEvent[];
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

@Injectable()
export class AdminQueryService {
	constructor(
		@Inject(TELEMETRY_REPOSITORY)
		private readonly repository: TelemetryRepository,
		@Inject(LIFECYCLE_REPOSITORY)
		private readonly lifecycleRepository: LifecycleRepository,
		@Inject(ADMIN_ANALYTICS_REPOSITORY)
		private readonly analyticsRepository: AdminAnalyticsRepository,
		@Optional()
		private readonly kafkaStatusService?: TelemetryKafkaConsumerStatusService,
		@Optional()
		private readonly lifecycleKafkaStatusService?: LifecycleKafkaConsumerStatusService,
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
			kafka: this.kafkaStatusService?.getHealth() ?? {
				enabled: false,
				connected: false,
				consumerLag: null,
				brokers: [],
				clientId: 'telemetry-api',
				groupId: 'file-telemetry-api',
				topic: 'file.image.events.v1',
				lastConsumedAt: null,
				lastError: null,
				disabledReason: 'Kafka consumer status provider가 없습니다.',
			},
			lifecycleKafka: this.lifecycleKafkaStatusService?.getHealth() ?? {
				enabled: false,
				connected: false,
				consumerLag: null,
				brokers: [],
				clientId: 'telemetry-api-lifecycle',
				groupId: 'file-telemetry-api-lifecycle',
				topic: 'file.image.lifecycle.v1',
				lastConsumedAt: null,
				lastError: null,
				disabledReason: 'Kafka lifecycle consumer status provider가 없습니다.',
			},
			metrics: await this.repository.getMetrics(),
			lifecycleMetrics: await this.lifecycleRepository.getMetrics(),
		};
	}

	async getSummary(query: Partial<EventFilter>): Promise<DashboardSummary> {
		return this.analyticsRepository.getSummary(query);
	}

	async getTimeseries(query: TimeseriesQuery): Promise<TimeseriesResponse> {
		return this.analyticsRepository.getTimeseries(query);
	}

	async listEvents(query: EventFilter): Promise<EventListResponse> {
		const limit = parseLimit(query.limit);
		const page = await this.repository.listEventPage(
			toEventListQuery(query, limit),
		);
		return {
			items: page.items,
			nextCursor: encodeEventListCursor(page.nextCursor),
		};
	}

	async listLifecycleEvents(
		query: LifecycleEventFilter,
	): Promise<LifecycleEventListResponse> {
		const limit = parseLimit(query.limit);
		const page = await this.lifecycleRepository.listEventPage(
			toEventListQuery(query, limit),
		);
		return {
			items: page.items,
			nextCursor: encodeEventListCursor(page.nextCursor),
		};
	}

	async listImageLifecycleEvents(
		imageKey: string,
		query: LifecycleEventFilter,
	): Promise<LifecycleEventListResponse> {
		return this.listLifecycleEvents({ ...query, imageKey });
	}

	async listImages(query: ImageFilter): Promise<ImageListResponse> {
		return this.analyticsRepository.listTopImages(query);
	}

	async getImage(imageKey: string): Promise<ImageListItem> {
		const image = await this.analyticsRepository.getImage(imageKey);
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
		return {
			items: await this.analyticsRepository.listVariants(imageKey),
		};
	}

	async listImageResizeRecommendations(
		query: ImageResizeRecommendationQuery,
	): Promise<ImageResizeRecommendationResponse> {
		return this.analyticsRepository.listResizeRecommendations(query);
	}
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

function toEventListQuery(
	query: EventFilter | LifecycleEventFilter,
	take: number,
): EventListQuery {
	const range = parseRange(query, true);
	return {
		eventType: query.eventType,
		sourceApp: query.sourceApp,
		clientServiceId: query.clientServiceId,
		clientServiceSlug: query.clientServiceSlug,
		status: query.status,
		from: range.from || undefined,
		to: range.to || undefined,
		search: query.search,
		path: query.path,
		name: query.name,
		imageKey: query.imageKey,
		requestId: query.requestId,
		...parseEventListCursor(query.cursor),
		take,
	};
}

function isValidDate(value: string): boolean {
	return Number.isFinite(new Date(value).getTime());
}
