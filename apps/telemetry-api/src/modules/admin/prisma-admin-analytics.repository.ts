import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@file/database';
import type {
	ImageVariantSummary,
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
	TimeseriesResponse,
	TopImageQuery,
} from './admin-analytics.types';
import {
	ImageListCursor,
	ImageSortField,
	ImageSortOrder,
	encodeImageListCursor,
	parseImageListCursor,
} from './image-list-cursor';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_MIN_REQUESTS = 3;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMESERIES_BUCKETS = 1500;
const MAX_VARIANTS_PER_IMAGE = 100;

interface ParsedRange {
	from?: Date;
	to?: Date;
	response?: {
		from: string;
		to: string;
	};
}

interface SummaryRow {
	totalEvents: unknown;
	totalReads: unknown;
	totalUploads: unknown;
	totalResizes: unknown;
	cacheHits: unknown;
	cacheMisses: unknown;
	failures: unknown;
	avgDurationMs: unknown;
	p95DurationMs: unknown;
	totalInputBytes: unknown;
	totalOutputBytes: unknown;
}

interface TimeseriesRow {
	bucketStart: Date | string;
	totalEvents: unknown;
	cacheHits: unknown;
	cacheMisses: unknown;
	resizeCompleted: unknown;
	uploadCompleted: unknown;
	failures: unknown;
	avgDurationMs: unknown;
	p95DurationMs: unknown;
}

interface TopImageRow {
	assetId: string | null;
	assetStatus: string | null;
	imageKey: string;
	imageId: number | null;
	path: string;
	name: string;
	format: string | null;
	originalName: string | null;
	bytes: number | null;
	checksum: string | null;
	totalReads: unknown;
	totalResizes: unknown;
	totalCacheHits: unknown;
	totalCacheMisses: unknown;
	totalFailures: unknown;
	avgDurationMs: unknown;
	p95DurationMs: unknown;
	lastSeenAt: Date | string;
}

interface ResizeRecommendationRow {
	clientServiceId: string | null;
	clientServiceSlug: string | null;
	width: number | null;
	height: number | null;
	format: string | null;
	requestCount: unknown;
	imageCount: unknown;
	avgDurationMs: unknown;
	p95DurationMs: unknown;
	estimatedSavedResizeMs: unknown;
	totalInputBytes: unknown;
	totalOutputBytes: unknown;
	lastRequestedAt: Date | string;
	sampleImageKeys: string[];
}

interface ImageVariantRow {
	variantId: string | null;
	status: string | null;
	storageKey: string | null;
	checksum: string | null;
	variantKey: string;
	imageKey: string;
	width: number | null;
	height: number | null;
	format: string | null;
	outputBytes: number | null;
	resizeCount: unknown;
	avgDurationMs: unknown;
	p95DurationMs: unknown;
	lastResizedAt: Date | string | null;
}

@Injectable()
export class PrismaAdminAnalyticsRepository implements AdminAnalyticsRepository {
	constructor(private readonly prisma: PrismaService) {}

	async getSummary(query: DashboardAnalyticsQuery): Promise<DashboardSummary> {
		const range = parseRequiredRange(query);
		const where = buildTelemetryWhere(query, range);
		const [row] = await this.prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
			SELECT
				COUNT(*)::bigint AS "totalEvents",
				COUNT(*) FILTER (
					WHERE "event_type" IN (
						'image.cache.hit',
						'image.cache.miss',
						'image.read.failed'
					)
				)::bigint AS "totalReads",
				COUNT(*) FILTER (
					WHERE "event_type" = 'image.upload.completed'
				)::bigint AS "totalUploads",
				COUNT(*) FILTER (
					WHERE "event_type" = 'image.resize.completed'
				)::bigint AS "totalResizes",
				COUNT(*) FILTER (
					WHERE "event_type" = 'image.cache.hit'
				)::bigint AS "cacheHits",
				COUNT(*) FILTER (
					WHERE "event_type" = 'image.cache.miss'
				)::bigint AS "cacheMisses",
				COUNT(*) FILTER (
					WHERE "status" = 'failed'
				)::bigint AS "failures",
				AVG("duration_ms") AS "avgDurationMs",
				percentile_disc(0.95) WITHIN GROUP (
					ORDER BY "duration_ms"
				) FILTER (
					WHERE "duration_ms" IS NOT NULL
				) AS "p95DurationMs",
				COALESCE(SUM("input_bytes"), 0)::bigint AS "totalInputBytes",
				COALESCE(SUM("output_bytes"), 0)::bigint AS "totalOutputBytes"
			FROM "telemetry_events"
			${where}
		`);

		const totalEvents = numberValue(row?.totalEvents);
		const cacheHits = numberValue(row?.cacheHits);
		const cacheMisses = numberValue(row?.cacheMisses);
		const cacheTotal = cacheHits + cacheMisses;
		const failures = numberValue(row?.failures);

		return {
			range: range.response!,
			totalEvents,
			totalReads: numberValue(row?.totalReads),
			totalUploads: numberValue(row?.totalUploads),
			totalResizes: numberValue(row?.totalResizes),
			cacheHitRate: rate(cacheHits, cacheTotal),
			cacheMissRate: rate(cacheMisses, cacheTotal),
			failureRate: rate(failures, totalEvents),
			avgDurationMs: optionalNumber(row?.avgDurationMs),
			p95DurationMs: optionalNumber(row?.p95DurationMs),
			totalInputBytes: numberValue(row?.totalInputBytes),
			totalOutputBytes: numberValue(row?.totalOutputBytes),
		};
	}

	async getTimeseries(query: TimeseriesQuery): Promise<TimeseriesResponse> {
		const interval = parseInterval(query.interval);
		const range = parseTimeseriesRange(query);
		assertBoundedBucketCount(range, interval);
		const where = buildTelemetryWhere(query, range);
		const rows = await this.prisma.$queryRaw<TimeseriesRow[]>(Prisma.sql`
			WITH "buckets" AS (
				SELECT generate_series(
					date_trunc(CAST(${interval} AS text), CAST(${range.from} AS timestamptz)),
					date_trunc(CAST(${interval} AS text), CAST(${range.to} AS timestamptz)),
					CASE CAST(${interval} AS text)
						WHEN 'minute' THEN INTERVAL '1 minute'
						WHEN 'hour' THEN INTERVAL '1 hour'
						ELSE INTERVAL '1 day'
					END
				) AS "bucketStart"
			),
			"metrics" AS (
				SELECT
					date_trunc(CAST(${interval} AS text), "occurred_at") AS "bucketStart",
					COUNT(*)::bigint AS "totalEvents",
					COUNT(*) FILTER (
						WHERE "event_type" = 'image.cache.hit'
					)::bigint AS "cacheHits",
					COUNT(*) FILTER (
						WHERE "event_type" = 'image.cache.miss'
					)::bigint AS "cacheMisses",
					COUNT(*) FILTER (
						WHERE "event_type" = 'image.resize.completed'
					)::bigint AS "resizeCompleted",
					COUNT(*) FILTER (
						WHERE "event_type" = 'image.upload.completed'
					)::bigint AS "uploadCompleted",
					COUNT(*) FILTER (
						WHERE "status" = 'failed'
					)::bigint AS "failures",
					AVG("duration_ms") AS "avgDurationMs",
					percentile_disc(0.95) WITHIN GROUP (
						ORDER BY "duration_ms"
					) FILTER (
						WHERE "duration_ms" IS NOT NULL
					) AS "p95DurationMs"
				FROM "telemetry_events"
				${where}
				GROUP BY 1
			)
			SELECT
				"buckets"."bucketStart",
				COALESCE("metrics"."totalEvents", 0)::bigint AS "totalEvents",
				COALESCE("metrics"."cacheHits", 0)::bigint AS "cacheHits",
				COALESCE("metrics"."cacheMisses", 0)::bigint AS "cacheMisses",
				COALESCE("metrics"."resizeCompleted", 0)::bigint AS "resizeCompleted",
				COALESCE("metrics"."uploadCompleted", 0)::bigint AS "uploadCompleted",
				COALESCE("metrics"."failures", 0)::bigint AS "failures",
				"metrics"."avgDurationMs",
				"metrics"."p95DurationMs"
			FROM "buckets"
			LEFT JOIN "metrics" USING ("bucketStart")
			ORDER BY "buckets"."bucketStart" ASC
		`);

		return {
			interval,
			points: rows.map((row) => {
				const cacheHits = numberValue(row.cacheHits);
				const cacheMisses = numberValue(row.cacheMisses);
				return {
					bucketStart: isoValue(row.bucketStart),
					totalEvents: numberValue(row.totalEvents),
					cacheHits,
					cacheMisses,
					cacheHitRate: rate(cacheHits, cacheHits + cacheMisses),
					resizeCompleted: numberValue(row.resizeCompleted),
					uploadCompleted: numberValue(row.uploadCompleted),
					failures: numberValue(row.failures),
					avgDurationMs: optionalNumber(row.avgDurationMs),
					p95DurationMs: optionalNumber(row.p95DurationMs),
				};
			}),
		};
	}

	async listTopImages(query: TopImageQuery): Promise<ImageListResponse> {
		const range = parseOptionalRange(query);
		const where = buildTelemetryWhere(query, range);
		const sortField = query.sort ?? 'lastSeenAt';
		const orderValue = query.order ?? 'desc';
		const parsedCursor = parseImageListCursor(
			query.cursor,
			sortField,
			orderValue,
		);
		const search = query.q
			? Prisma.sql`
				WHERE POSITION(
					LOWER(${query.q}) IN LOWER(
						"imageKey" || ' ' || "path" || ' ' || "name"
					)
				) > 0
			`
			: Prisma.sql``;
		const sort = imageSortSql(sortField);
		const order = orderValue === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
		const cursor = parsedCursor.cursor
			? imageCursorSql(parsedCursor.cursor, sort)
			: Prisma.sql``;
		const offset =
			parsedCursor.offset === undefined
				? Prisma.sql``
				: Prisma.sql`OFFSET ${parsedCursor.offset}`;
		const limit = parseLimit(query.limit);
		const dualRead = isAssetDualReadEnabled();
		const authoritativeAssetWhere = buildAuthoritativeAssetWhere(query, range);

		const rows = await this.prisma.$queryRaw<TopImageRow[]>(Prisma.sql`
			WITH "filtered_events" AS (
				SELECT * FROM "telemetry_events" ${where}
			),
			"authoritative_assets" AS (
				SELECT
					"asset"."asset_id" AS "assetId",
					"asset"."status"::text AS "assetStatus",
					"asset"."storage_key" AS "imageKey",
					"asset"."external_image_id" AS "imageId",
					"asset"."logical_path" AS "path",
					"asset"."name",
					"asset"."original_name" AS "originalName",
					"asset"."format",
					"asset"."bytes",
					"asset"."checksum",
					"asset"."updated_at" AS "assetUpdatedAt"
				FROM "image_assets" AS "asset"
				JOIN "client_services" AS "owner"
					ON "owner"."id" = "asset"."client_service_id"
				${authoritativeAssetWhere}
			),
			"legacy_assets" AS (
				SELECT DISTINCT ON ("event"."image_key")
					NULL::text AS "assetId",
					'Legacy'::text AS "assetStatus",
					"event"."image_key" AS "imageKey",
					"event"."image_id" AS "imageId",
					"event"."path",
					"event"."name",
					COALESCE("event"."raw_payload"->>'originalName', "event"."name") AS "originalName",
					"event"."format",
					"event"."output_bytes" AS "bytes",
					NULL::text AS "checksum",
					"event"."occurred_at" AS "assetUpdatedAt"
				FROM "filtered_events" AS "event"
				WHERE ${dualRead}
					AND "event"."event_type" = 'image.upload.completed'
					AND "event"."status" = 'success'
						AND NOT EXISTS (
							SELECT 1 FROM "image_assets" AS "asset"
							WHERE "asset"."storage_key" = "event"."image_key"
						)
						AND NOT EXISTS (
							SELECT 1 FROM "telemetry_events" AS "deleted"
							WHERE "deleted"."event_type" = 'image.delete.completed'
								AND "deleted"."status" = 'success'
								AND "deleted"."client_service_id" = "event"."client_service_id"
								AND "deleted"."image_key" = "event"."image_key"
								AND ("deleted"."occurred_at", "deleted"."event_id") >
									("event"."occurred_at", "event"."event_id")
						)
						AND NOT EXISTS (
							SELECT 1 FROM "image_lifecycle_events" AS "deleted"
							WHERE "deleted"."event_type" = 'image.delete.completed'
								AND "deleted"."status" = 'success'
								AND "deleted"."client_service_id" = "event"."client_service_id"
								AND "deleted"."image_key" = "event"."image_key"
								AND ("deleted"."occurred_at", "deleted"."event_id") >
									("event"."occurred_at", "event"."event_id")
						)
				ORDER BY "event"."image_key", "event"."occurred_at" DESC, "event"."event_id" DESC
			),
			"assets" AS (
				SELECT * FROM "authoritative_assets"
				UNION ALL
				SELECT * FROM "legacy_assets"
			),
			"grouped" AS (
				SELECT
					"assets"."assetId",
					"assets"."assetStatus",
					"assets"."imageKey",
					"assets"."imageId",
					"assets"."path",
					"assets"."name",
					"assets"."originalName",
					"assets"."format",
					"assets"."bytes",
					"assets"."checksum",
					COUNT("events"."id") FILTER (
						WHERE "events"."event_type" IN (
							'image.cache.hit', 'image.cache.miss',
							'image.read.completed', 'image.read.failed'
						)
					)::bigint AS "totalReads",
					COUNT("events"."id") FILTER (
						WHERE "events"."event_type" = 'image.resize.completed'
					)::bigint AS "totalResizes",
					COUNT("events"."id") FILTER (
						WHERE "events"."event_type" = 'image.cache.hit'
					)::bigint AS "totalCacheHits",
					COUNT("events"."id") FILTER (
						WHERE "events"."event_type" = 'image.cache.miss'
					)::bigint AS "totalCacheMisses",
					COUNT("events"."id") FILTER (
						WHERE "events"."status" = 'failed'
					)::bigint AS "totalFailures",
					AVG("events"."duration_ms") AS "avgDurationMs",
					percentile_disc(0.95) WITHIN GROUP (
						ORDER BY "events"."duration_ms"
					) FILTER (
						WHERE "events"."duration_ms" IS NOT NULL
					) AS "p95DurationMs",
					COALESCE(MAX("events"."occurred_at"), "assets"."assetUpdatedAt") AS "lastSeenAt"
				FROM "assets"
				LEFT JOIN "filtered_events" AS "events"
					ON "events"."image_key" = "assets"."imageKey"
				GROUP BY
					"assets"."assetId", "assets"."assetStatus", "assets"."imageKey",
					"assets"."imageId", "assets"."path", "assets"."name",
					"assets"."originalName", "assets"."format", "assets"."bytes",
					"assets"."checksum", "assets"."assetUpdatedAt"
			),
			"searched" AS (
				SELECT * FROM "grouped" ${search}
			)
			SELECT * FROM "searched"
			${cursor}
			ORDER BY ${sort} ${order}, "imageKey" ${order}
			LIMIT ${limit + 1}
			${offset}
		`);

		const items = rows.slice(0, limit).map(toImageListItem);
		const lastItem = items.at(-1);
		const nextCursor =
			rows.length <= limit || !lastItem
				? undefined
				: encodeImageListCursor(
						toImageListCursor(lastItem, sortField, orderValue),
					);
		return { items, nextCursor };
	}

	async getImage(imageKey: string): Promise<ImageListItem | undefined> {
		const dualRead = isAssetDualReadEnabled();
		const [row] = await this.prisma.$queryRaw<TopImageRow[]>(Prisma.sql`
			WITH "asset" AS (
				SELECT
					"asset_id" AS "assetId",
					"status"::text AS "assetStatus",
					"storage_key" AS "imageKey",
					"external_image_id" AS "imageId",
					"logical_path" AS "path",
					"name", "original_name" AS "originalName", "format", "bytes", "checksum",
					"updated_at" AS "assetUpdatedAt"
				FROM "image_assets"
				WHERE "storage_key" = ${imageKey}
					AND "status" <> 'Deleted'::"ImageAssetState"
				UNION ALL
				SELECT
					NULL::text, 'Legacy'::text, "event"."image_key", "event"."image_id",
					"event"."path", "event"."name",
					COALESCE("event"."raw_payload"->>'originalName', "event"."name"),
					"event"."format", "event"."output_bytes", NULL::text, "event"."occurred_at"
				FROM "telemetry_events" AS "event"
				WHERE ${dualRead}
					AND "event"."image_key" = ${imageKey}
					AND "event"."event_type" = 'image.upload.completed'
					AND "event"."status" = 'success'
					AND NOT EXISTS (
						SELECT 1 FROM "image_assets" WHERE "storage_key" = ${imageKey}
					)
					AND NOT EXISTS (
						SELECT 1 FROM "telemetry_events" AS "deleted"
						WHERE "deleted"."event_type" = 'image.delete.completed'
							AND "deleted"."status" = 'success'
							AND "deleted"."client_service_id" = "event"."client_service_id"
							AND "deleted"."image_key" = "event"."image_key"
							AND ("deleted"."occurred_at", "deleted"."event_id") >
								("event"."occurred_at", "event"."event_id")
					)
					AND NOT EXISTS (
						SELECT 1 FROM "image_lifecycle_events" AS "deleted"
						WHERE "deleted"."event_type" = 'image.delete.completed'
							AND "deleted"."status" = 'success'
							AND "deleted"."client_service_id" = "event"."client_service_id"
							AND "deleted"."image_key" = "event"."image_key"
							AND ("deleted"."occurred_at", "deleted"."event_id") >
								("event"."occurred_at", "event"."event_id")
					)
				ORDER BY "assetUpdatedAt" DESC
				LIMIT 1
			)
			SELECT
				"asset"."assetId", "asset"."assetStatus", "asset"."imageKey",
				"asset"."imageId", "asset"."path", "asset"."name",
				"asset"."originalName", "asset"."format", "asset"."bytes", "asset"."checksum",
				COUNT("event"."id") FILTER (
					WHERE "event"."event_type" IN (
						'image.cache.hit', 'image.cache.miss',
						'image.read.completed', 'image.read.failed'
					)
				)::bigint AS "totalReads",
				COUNT("event"."id") FILTER (
					WHERE "event"."event_type" = 'image.resize.completed'
				)::bigint AS "totalResizes",
				COUNT("event"."id") FILTER (
					WHERE "event"."event_type" = 'image.cache.hit'
				)::bigint AS "totalCacheHits",
				COUNT("event"."id") FILTER (
					WHERE "event"."event_type" = 'image.cache.miss'
				)::bigint AS "totalCacheMisses",
				COUNT("event"."id") FILTER (
					WHERE "event"."status" = 'failed'
				)::bigint AS "totalFailures",
				AVG("event"."duration_ms") AS "avgDurationMs",
				percentile_disc(0.95) WITHIN GROUP (
					ORDER BY "event"."duration_ms"
				) FILTER (
					WHERE "event"."duration_ms" IS NOT NULL
				) AS "p95DurationMs",
				COALESCE(MAX("event"."occurred_at"), "asset"."assetUpdatedAt") AS "lastSeenAt"
			FROM "asset"
			LEFT JOIN "telemetry_events" AS "event"
				ON "event"."image_key" = "asset"."imageKey"
			GROUP BY
				"asset"."assetId", "asset"."assetStatus", "asset"."imageKey",
				"asset"."imageId", "asset"."path", "asset"."name",
				"asset"."originalName", "asset"."format", "asset"."bytes",
				"asset"."checksum", "asset"."assetUpdatedAt"
			LIMIT 1
		`);
		return row ? toImageListItem(row) : undefined;
	}

	async listVariants(imageKey: string): Promise<ImageVariantSummary[]> {
		const rows = await this.prisma.$queryRaw<ImageVariantRow[]>(Prisma.sql`
			SELECT
				"variant"."variant_id" AS "variantId",
				"variant"."status"::text AS "status",
				"variant"."storage_key" AS "storageKey",
				"variant"."checksum",
				"variant"."spec_key" AS "variantKey",
				"asset"."storage_key" AS "imageKey",
				"variant"."width", "variant"."height", "variant"."format",
				"variant"."bytes" AS "outputBytes",
				COUNT("event"."id")::bigint AS "resizeCount",
				AVG("event"."duration_ms") AS "avgDurationMs",
				percentile_disc(0.95) WITHIN GROUP (
					ORDER BY "event"."duration_ms"
				) FILTER (
					WHERE "event"."duration_ms" IS NOT NULL
				) AS "p95DurationMs",
				MAX("event"."occurred_at") AS "lastResizedAt"
			FROM "image_assets" AS "asset"
			JOIN "image_variants" AS "variant" ON "variant"."asset_id" = "asset"."asset_id"
			LEFT JOIN "telemetry_events" AS "event"
				ON "event"."image_key" = "asset"."storage_key"
				AND "event"."event_type" = 'image.resize.completed'
				AND "event"."width" IS NOT DISTINCT FROM "variant"."width"
				AND "event"."height" IS NOT DISTINCT FROM "variant"."height"
				AND "event"."format" = "variant"."format"
			WHERE "asset"."storage_key" = ${imageKey}
				AND "asset"."status" <> 'Deleted'::"ImageAssetState"
				AND "variant"."status" <> 'Deleted'::"ImageVariantState"
			GROUP BY "asset"."asset_id", "variant"."variant_id"
			ORDER BY "lastResizedAt" DESC NULLS LAST, "variantKey" DESC
			LIMIT ${MAX_VARIANTS_PER_IMAGE}
		`);
		if (rows.length || !isAssetDualReadEnabled()) {
			return rows.map(toImageVariantSummary);
		}

		const legacyRows = await this.prisma.$queryRaw<
			ImageVariantRow[]
		>(Prisma.sql`
			SELECT
				NULL::text AS "variantId", 'Legacy'::text AS "status",
				NULL::text AS "storageKey", NULL::text AS "checksum",
				"image_key" || ':' || COALESCE("width"::text, 'auto') || 'x' ||
				COALESCE("height"::text, 'auto') || ':' || COALESCE("format", 'unknown') AS "variantKey",
				"image_key" AS "imageKey", "width", "height", "format",
				(array_agg("output_bytes" ORDER BY "occurred_at" DESC, "event_id" DESC)
					FILTER (WHERE "output_bytes" IS NOT NULL))[1] AS "outputBytes",
				COUNT(*)::bigint AS "resizeCount", AVG("duration_ms") AS "avgDurationMs",
				percentile_disc(0.95) WITHIN GROUP (ORDER BY "duration_ms")
					FILTER (WHERE "duration_ms" IS NOT NULL) AS "p95DurationMs",
				MAX("occurred_at") AS "lastResizedAt"
			FROM "telemetry_events"
			WHERE "image_key" = ${imageKey} AND "event_type" = 'image.resize.completed'
			GROUP BY "image_key", "width", "height", "format"
			ORDER BY "lastResizedAt" DESC, "variantKey" DESC
			LIMIT ${MAX_VARIANTS_PER_IMAGE}
		`);
		return legacyRows.map(toImageVariantSummary);
	}

	async listResizeRecommendations(
		query: ImageResizeRecommendationQuery,
	): Promise<ImageResizeRecommendationResponse> {
		const range = parseOptionalRange(query);
		const minRequests = parseMinRequests(query.minRequests);
		const limit = parseLimit(query.limit);
		const where = buildTelemetryWhere(query, range, [
			Prisma.sql`"event_type" = 'image.resize.completed'`,
			Prisma.sql`"status" = 'success'`,
			Prisma.sql`"cache_key" IS NULL`,
			Prisma.sql`("client_service_id" IS NOT NULL OR "client_service_slug" IS NOT NULL)`,
			Prisma.sql`("width" IS NOT NULL OR "height" IS NOT NULL)`,
		]);

		const rows = await this.prisma.$queryRaw<ResizeRecommendationRow[]>(
			Prisma.sql`
				SELECT
					"client_service_id" AS "clientServiceId",
					"client_service_slug" AS "clientServiceSlug",
					"width",
					"height",
					"format",
					COUNT(*)::bigint AS "requestCount",
					COUNT(DISTINCT "image_key")::bigint AS "imageCount",
					AVG("duration_ms") AS "avgDurationMs",
					percentile_disc(0.95) WITHIN GROUP (
						ORDER BY "duration_ms"
					) FILTER (
						WHERE "duration_ms" IS NOT NULL
					) AS "p95DurationMs",
					COALESCE(SUM("duration_ms"), 0) AS "estimatedSavedResizeMs",
					COALESCE(SUM("input_bytes"), 0)::bigint AS "totalInputBytes",
					COALESCE(SUM("output_bytes"), 0)::bigint AS "totalOutputBytes",
					MAX("occurred_at") AS "lastRequestedAt",
					(array_agg(
						"image_key" ORDER BY "occurred_at" ASC, "event_id" ASC
					))[1:5] AS "sampleImageKeys"
				FROM "telemetry_events"
				${where}
				GROUP BY
					"client_service_id",
					"client_service_slug",
					"width",
					"height",
					"format"
				ORDER BY
					(COUNT(*) >= ${minRequests}) DESC,
					COUNT(*) DESC,
					COALESCE(SUM("duration_ms"), 0) DESC,
					MAX("occurred_at") DESC,
					"client_service_id" ASC NULLS LAST,
					"client_service_slug" ASC NULLS LAST,
					"width" ASC NULLS LAST,
					"height" ASC NULLS LAST,
					"format" ASC NULLS LAST
				LIMIT ${limit}
			`,
		);

		return {
			threshold: { minRequests },
			items: rows.map((row) => toResizeRecommendationItem(row, minRequests)),
		};
	}
}

function buildAuthoritativeAssetWhere(
	query: TopImageQuery,
	range: ParsedRange,
): Prisma.Sql {
	const conditions: Prisma.Sql[] = [
		Prisma.sql`"asset"."status" <> 'Deleted'::"ImageAssetState"`,
	];
	if (query.clientServiceId) {
		conditions.push(
			Prisma.sql`"asset"."client_service_id" = ${query.clientServiceId}`,
		);
	}
	if (query.clientServiceSlug) {
		conditions.push(Prisma.sql`"owner"."slug" = ${query.clientServiceSlug}`);
	}
	if (range.from || range.to) {
		conditions.push(Prisma.sql`
			EXISTS (
				SELECT 1
				FROM "filtered_events" AS "membership_event"
				WHERE "membership_event"."image_key" = "asset"."storage_key"
					AND "membership_event"."client_service_id" = "asset"."client_service_id"
			)
		`);
	}

	return Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
}

function buildTelemetryWhere(
	query:
		| DashboardAnalyticsQuery
		| TimeseriesQuery
		| TopImageQuery
		| ImageResizeRecommendationQuery,
	range: ParsedRange,
	extraConditions: Prisma.Sql[] = [],
): Prisma.Sql {
	const conditions = [...extraConditions];
	if (range.from) {
		conditions.push(Prisma.sql`"occurred_at" >= ${range.from}`);
	}
	if (range.to) {
		conditions.push(Prisma.sql`"occurred_at" <= ${range.to}`);
	}
	if ('eventType' in query && query.eventType) {
		conditions.push(Prisma.sql`"event_type" = ${query.eventType}`);
	}
	if ('sourceApp' in query && query.sourceApp) {
		conditions.push(Prisma.sql`"source_app" = ${query.sourceApp}`);
	}
	if ('status' in query && query.status) {
		conditions.push(Prisma.sql`"status" = ${query.status}`);
	}
	if (query.clientServiceId) {
		conditions.push(Prisma.sql`"client_service_id" = ${query.clientServiceId}`);
	}
	if (query.clientServiceSlug) {
		conditions.push(
			Prisma.sql`"client_service_slug" = ${query.clientServiceSlug}`,
		);
	}
	if ('path' in query && query.path) {
		conditions.push(Prisma.sql`POSITION(${query.path} IN "path") > 0`);
	}
	if ('name' in query && query.name) {
		conditions.push(Prisma.sql`POSITION(${query.name} IN "name") > 0`);
	}
	if ('imageKey' in query && query.imageKey) {
		conditions.push(Prisma.sql`"image_key" = ${query.imageKey}`);
	}
	if ('requestId' in query && query.requestId) {
		conditions.push(Prisma.sql`"request_id" = ${query.requestId}`);
	}

	return conditions.length === 0
		? Prisma.sql``
		: Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
}

function parseRequiredRange(query: DashboardAnalyticsQuery): ParsedRange {
	const from = query.from ?? '1970-01-01T00:00:00.000Z';
	const to = query.to ?? new Date().toISOString();
	const parsed = parseRange(from, to);
	return { ...parsed, response: { from, to } };
}

function parseTimeseriesRange(query: TimeseriesQuery): ParsedRange {
	const now = new Date();
	const from = query.from ?? new Date(now.getTime() - ONE_DAY_MS).toISOString();
	const to = query.to ?? now.toISOString();
	return parseRange(from, to);
}

function assertBoundedBucketCount(
	range: ParsedRange,
	interval: BucketInterval,
): void {
	if (!range.from || !range.to) {
		throw new Error('Timeseries range must have both boundaries');
	}
	const intervalMs =
		interval === 'minute'
			? 60 * 1000
			: interval === 'hour'
				? 60 * 60 * 1000
				: ONE_DAY_MS;
	const maximumBucketCount =
		Math.floor((range.to.getTime() - range.from.getTime()) / intervalMs) + 2;
	if (maximumBucketCount > MAX_TIMESERIES_BUCKETS) {
		throw new BadRequestException(
			`timeseries range must produce at most ${MAX_TIMESERIES_BUCKETS} buckets`,
		);
	}
}

function parseOptionalRange(query: {
	from?: string;
	to?: string;
}): ParsedRange {
	if (!query.from && !query.to) {
		return {};
	}
	return parseRange(query.from, query.to);
}

function parseRange(from?: string, to?: string): ParsedRange {
	const parsedFrom = from ? parseDate(from) : undefined;
	const parsedTo = to ? parseDate(to) : undefined;
	if (parsedFrom && parsedTo && parsedFrom.getTime() > parsedTo.getTime()) {
		throw new BadRequestException('from must be earlier than to');
	}
	return { from: parsedFrom, to: parsedTo };
}

function parseDate(value: string): Date {
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) {
		throw new BadRequestException('from and to must be ISO date strings');
	}
	return parsed;
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
		return DEFAULT_MIN_REQUESTS;
	}
	if (!Number.isInteger(minRequests) || minRequests < 1) {
		throw new BadRequestException('minRequests must be a positive integer');
	}
	return minRequests;
}

function imageSortSql(sort: TopImageQuery['sort']): Prisma.Sql {
	if (sort === 'reads') {
		return Prisma.sql`"totalReads"`;
	}
	if (sort === 'resizes') {
		return Prisma.sql`"totalResizes"`;
	}
	if (sort === 'cacheMisses') {
		return Prisma.sql`"totalCacheMisses"`;
	}
	if (sort === 'failures') {
		return Prisma.sql`"totalFailures"`;
	}
	return Prisma.sql`"lastSeenAt"`;
}

function imageCursorSql(cursor: ImageListCursor, sort: Prisma.Sql): Prisma.Sql {
	const sortValue =
		cursor.sort === 'lastSeenAt'
			? new Date(String(cursor.sortValue))
			: cursor.sortValue;
	return cursor.order === 'asc'
		? Prisma.sql`WHERE (${sort}, "imageKey") > (${sortValue}, ${cursor.imageKey})`
		: Prisma.sql`WHERE (${sort}, "imageKey") < (${sortValue}, ${cursor.imageKey})`;
}

function toImageListCursor(
	item: ImageListItem,
	sort: ImageSortField,
	order: ImageSortOrder,
): ImageListCursor {
	return {
		sort,
		order,
		sortValue: imageSortValue(item, sort),
		imageKey: item.imageKey,
	};
}

function imageSortValue(
	item: ImageListItem,
	sort: ImageSortField,
): number | string {
	if (sort === 'reads') {
		return item.totalReads;
	}
	if (sort === 'resizes') {
		return item.totalResizes;
	}
	if (sort === 'cacheMisses') {
		return item.totalCacheMisses;
	}
	if (sort === 'failures') {
		return item.totalFailures;
	}
	return item.lastSeenAt;
}

function toImageListItem(row: TopImageRow): ImageListItem {
	const totalCacheHits = numberValue(row.totalCacheHits);
	const totalCacheMisses = numberValue(row.totalCacheMisses);
	return {
		assetId: row.assetId ?? undefined,
		assetStatus: row.assetStatus ?? undefined,
		imageKey: row.imageKey,
		imageId: row.imageId ?? undefined,
		path: row.path,
		name: row.name,
		format: row.format ?? undefined,
		originalName: row.originalName ?? undefined,
		bytes: row.bytes ?? undefined,
		checksum: row.checksum ?? undefined,
		totalReads: numberValue(row.totalReads),
		totalResizes: numberValue(row.totalResizes),
		totalCacheHits,
		totalCacheMisses,
		cacheHitRate: rate(totalCacheHits, totalCacheHits + totalCacheMisses),
		totalFailures: numberValue(row.totalFailures),
		avgDurationMs: optionalNumber(row.avgDurationMs),
		p95DurationMs: optionalNumber(row.p95DurationMs),
		lastSeenAt: isoValue(row.lastSeenAt),
	};
}

function toImageVariantSummary(row: ImageVariantRow): ImageVariantSummary {
	return {
		variantId: row.variantId ?? undefined,
		status: row.status ?? undefined,
		storageKey: row.storageKey ?? undefined,
		checksum: row.checksum ?? undefined,
		variantKey: row.variantKey,
		imageKey: row.imageKey,
		width: row.width ?? undefined,
		height: row.height ?? undefined,
		format: (row.format ?? undefined) as ImageVariantSummary['format'],
		outputBytes: row.outputBytes ?? undefined,
		resizeCount: numberValue(row.resizeCount),
		avgDurationMs: optionalNumber(row.avgDurationMs),
		p95DurationMs: optionalNumber(row.p95DurationMs),
		lastResizedAt: row.lastResizedAt ? isoValue(row.lastResizedAt) : undefined,
	};
}

function isAssetDualReadEnabled() {
	return process.env.IMAGE_ASSET_DUAL_READ_ENABLED !== 'false';
}

function toResizeRecommendationItem(
	row: ResizeRecommendationRow,
	minRequests: number,
): ImageResizeRecommendationItem {
	const requestCount = numberValue(row.requestCount);
	const clientServiceId = row.clientServiceId ?? undefined;
	const clientServiceSlug = row.clientServiceSlug ?? undefined;
	const width = row.width ?? undefined;
	const height = row.height ?? undefined;
	const format = row.format ?? undefined;
	return {
		recommendationKey: [
			clientServiceId ?? 'unknown-id',
			clientServiceSlug ?? 'unknown-slug',
			width ?? 'auto',
			height ?? 'auto',
			format ?? 'unknown',
		].join(':'),
		clientServiceId,
		clientServiceSlug,
		width,
		height,
		format,
		requestCount,
		imageCount: numberValue(row.imageCount),
		avgDurationMs: optionalNumber(row.avgDurationMs),
		p95DurationMs: optionalNumber(row.p95DurationMs),
		estimatedSavedResizeMs: numberValue(row.estimatedSavedResizeMs),
		totalInputBytes: numberValue(row.totalInputBytes),
		totalOutputBytes: numberValue(row.totalOutputBytes),
		lastRequestedAt: isoValue(row.lastRequestedAt),
		sampleImageKeys: [...new Set(row.sampleImageKeys)],
		recommended: requestCount >= minRequests,
	};
}

function numberValue(value: unknown): number {
	if (value === null || value === undefined) {
		return 0;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error('PostgreSQL analytics returned a non-numeric value');
	}
	return parsed;
}

function optionalNumber(value: unknown): number | null {
	return value === null || value === undefined ? null : numberValue(value);
}

function rate(part: number, total: number): number | null {
	return total === 0 ? null : part / total;
}

function isoValue(value: Date | string): string {
	const parsed = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(parsed.getTime())) {
		throw new Error('PostgreSQL analytics returned an invalid timestamp');
	}
	return parsed.toISOString();
}
