import {
	BadRequestException,
	Inject,
	Injectable,
	NotFoundException,
	Optional,
} from '@nestjs/common';
import { PrismaService } from '@file/database';
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
		@Optional()
		private readonly prisma?: PrismaService,
	) {}

	async getHealth() {
		const timeoutMs = readHealthTimeoutMs();
		const [storageConnected, lifecycleStorageConnected] = await Promise.all([
			withHealthTimeout(this.repository.isConnected(), timeoutMs, false),
			withHealthTimeout(
				this.lifecycleRepository.isConnected(),
				timeoutMs,
				false,
			),
		]);
		const kafka =
			this.kafkaStatusService?.getHealth() ?? disabledTelemetryKafkaHealth();
		const lifecycleKafka =
			this.lifecycleKafkaStatusService?.getHealth() ??
			disabledLifecycleKafkaHealth();
		const [metrics, lifecycleMetrics, outbox] = await Promise.all([
			withHealthTimeout(
				readMetrics(() => this.repository.getMetrics()),
				timeoutMs,
				unavailableMetrics(),
			),
			withHealthTimeout(
				readMetrics(() => this.lifecycleRepository.getMetrics()),
				timeoutMs,
				unavailableMetrics(),
			),
			withHealthTimeout(
				this.getOutboxMetrics(storageConnected && lifecycleStorageConnected),
				timeoutMs,
				unavailableOutboxMetrics(),
			),
		]);
		const ok =
			storageConnected &&
			lifecycleStorageConnected &&
			kafka.ready &&
			lifecycleKafka.ready;

		return {
			ok,
			service: 'telemetry-api',
			checkedAt: new Date().toISOString(),
			storage: {
				kind: this.repository.getStorageKind(),
				connected: storageConnected,
			},
			lifecycleStorage: {
				kind: this.lifecycleRepository.getStorageKind(),
				connected: lifecycleStorageConnected,
			},
			kafka,
			lifecycleKafka,
			metrics,
			lifecycleMetrics,
			operationalMetrics: {
				kafka: {
					consumerLag: kafka.consumerLag,
					dlqCount: kafka.dlqCount,
					reconnectAttempts: kafka.reconnectAttempts,
				},
				lifecycleKafka: {
					consumerLag: lifecycleKafka.consumerLag,
					dlqCount: lifecycleKafka.dlqCount,
					reconnectAttempts: lifecycleKafka.reconnectAttempts,
				},
				outbox,
				reconciliation: {
					supported: false,
					orphanCount: null,
					disabledReason:
						'Authoritative asset reconciliation belongs to Stage 5.',
				},
			},
		};
	}

	private async getOutboxMetrics(databaseReady: boolean) {
		if (!databaseReady || !this.prisma) {
			return {
				available: false,
				pendingCount: null,
				publishingCount: null,
				failedCount: null,
				deadLetterCount: null,
				publishedCount: null,
				retryCount: null,
				oldestUnpublishedAgeMs: null,
			};
		}

		try {
			const activeStatuses = ['PENDING', 'PUBLISHING', 'FAILED'];
			const [
				pendingCount,
				publishingCount,
				failedCount,
				deadLetterCount,
				publishedCount,
				active,
			] = await Promise.all([
				this.prisma.imageLifecycleOutbox.count({
					where: { status: 'PENDING' },
				}),
				this.prisma.imageLifecycleOutbox.count({
					where: { status: 'PUBLISHING' },
				}),
				this.prisma.imageLifecycleOutbox.count({
					where: { status: 'FAILED' },
				}),
				this.prisma.imageLifecycleOutbox.count({
					where: { status: 'DEAD_LETTER' },
				}),
				this.prisma.imageLifecycleOutbox.count({
					where: { status: 'PUBLISHED' },
				}),
				this.prisma.imageLifecycleOutbox.aggregate({
					where: { status: { in: activeStatuses } },
					_sum: { attempts: true },
					_min: { createdAt: true },
				}),
			]);
			const oldestCreatedAt = active._min.createdAt;
			return {
				available: true,
				pendingCount,
				publishingCount,
				failedCount,
				deadLetterCount,
				publishedCount,
				retryCount: active._sum.attempts ?? 0,
				oldestUnpublishedAgeMs: oldestCreatedAt
					? Math.max(0, Date.now() - oldestCreatedAt.getTime())
					: null,
			};
		} catch {
			return {
				available: false,
				pendingCount: null,
				publishingCount: null,
				failedCount: null,
				deadLetterCount: null,
				publishedCount: null,
				retryCount: null,
				oldestUnpublishedAgeMs: null,
			};
		}
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

async function readMetrics(
	read: () => Promise<{
		validationFailureCount: number;
		insertFailureCount: number;
		lastConsumedEventAt: string | null;
	}>,
) {
	try {
		return { available: true, ...(await read()) };
	} catch {
		return {
			available: false,
			validationFailureCount: null,
			insertFailureCount: null,
			lastConsumedEventAt: null,
		};
	}
}

function disabledTelemetryKafkaHealth() {
	return disabledKafkaHealth({
		clientId: 'telemetry-api',
		groupId: 'file-telemetry-api',
		topic: 'file.image.events.v1',
		disabledReason: 'Kafka consumer status provider가 없습니다.',
	});
}

function disabledLifecycleKafkaHealth() {
	return disabledKafkaHealth({
		clientId: 'telemetry-api-lifecycle',
		groupId: 'file-telemetry-api-lifecycle',
		topic: 'file.image.lifecycle.v1',
		disabledReason: 'Kafka lifecycle consumer status provider가 없습니다.',
	});
}

function disabledKafkaHealth(input: {
	clientId: string;
	groupId: string;
	topic: string;
	disabledReason: string;
}) {
	return {
		enabled: false,
		connected: false,
		brokerConnected: false,
		ready: true,
		consumerLag: null,
		partitionLag: [],
		brokers: [],
		clientId: input.clientId,
		groupId: input.groupId,
		topic: input.topic,
		lastConsumedAt: null,
		lastError: null,
		lastLagError: null,
		lagCheckedAt: null,
		reconnectAttempts: 0,
		nextReconnectAt: null,
		dlqCount: 0,
		disabledReason: input.disabledReason,
	};
}

function unavailableMetrics() {
	return {
		available: false,
		validationFailureCount: null,
		insertFailureCount: null,
		lastConsumedEventAt: null,
	};
}

function unavailableOutboxMetrics() {
	return {
		available: false,
		pendingCount: null,
		publishingCount: null,
		failedCount: null,
		deadLetterCount: null,
		publishedCount: null,
		retryCount: null,
		oldestUnpublishedAgeMs: null,
	};
}

function readHealthTimeoutMs(): number {
	const parsed = Number(process.env.HEALTH_PROBE_TIMEOUT_MS);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 2_000;
}

async function withHealthTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	fallback: T,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(fallback), timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
