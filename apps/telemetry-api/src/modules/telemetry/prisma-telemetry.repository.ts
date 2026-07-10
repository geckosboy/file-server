import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@file/database';
import {
	assertBoundedEventListQuery,
	EventListPage,
	EventListQuery,
	toEventListCursor,
} from './event-list-query';
import {
	ImageAssetSummary,
	ImageTelemetryEvent,
	ImageVariantSummary,
	TelemetryMetrics,
	UnknownRecord,
} from './telemetry.types';
import {
	projectAssetSummaries,
	projectVariantSummaries,
	TelemetryRepository,
} from './telemetry.repository';

const METRIC_ID = 'default';

@Injectable()
export class PrismaTelemetryRepository implements TelemetryRepository {
	constructor(private readonly prisma: PrismaService) {}

	async insertEvent(
		event: ImageTelemetryEvent,
	): Promise<{ inserted: boolean }> {
		try {
			await this.prisma.telemetryEvent.create({
				data: toCreateInput(event),
			});
			await this.upsertMetrics({
				lastConsumedEventAt: new Date(event.receivedAt),
			});
			return { inserted: true };
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				return { inserted: false };
			}
			throw error;
		}
	}

	async recordValidationFailure(): Promise<void> {
		await this.upsertMetrics({ validationFailureIncrement: 1 });
	}

	async recordInsertFailure(): Promise<void> {
		await this.upsertMetrics({ insertFailureIncrement: 1 });
	}

	async getMetrics(): Promise<TelemetryMetrics> {
		const metrics = await this.prisma.telemetryIngestionMetric.findUnique({
			where: { id: METRIC_ID },
		});

		return {
			validationFailureCount: metrics?.validationFailureCount ?? 0,
			insertFailureCount: metrics?.insertFailureCount ?? 0,
			lastConsumedEventAt: metrics?.lastConsumedEventAt?.toISOString() ?? null,
		};
	}

	async listEvents(): Promise<ImageTelemetryEvent[]> {
		const rows = await this.prisma.telemetryEvent.findMany({
			orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }],
		});
		return rows.map(toTelemetryEvent);
	}

	async listEventPage(
		query: EventListQuery,
	): Promise<EventListPage<ImageTelemetryEvent>> {
		assertBoundedEventListQuery(query);
		const rows = await this.prisma.telemetryEvent.findMany({
			where: toTelemetryEventWhere(query),
			orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
			take: query.take + 1,
			skip: query.offset,
		});
		const hasMore = rows.length > query.take;
		const items = rows.slice(0, query.take).map(toTelemetryEvent);

		return {
			items,
			nextCursor: hasMore ? toEventListCursor(items.at(-1)) : undefined,
		};
	}

	async listAssets(): Promise<ImageAssetSummary[]> {
		return projectAssetSummaries(await this.listEvents());
	}

	async listVariants(imageKey?: string): Promise<ImageVariantSummary[]> {
		return projectVariantSummaries(await this.listEvents(), imageKey);
	}

	async clear(): Promise<void> {
		await this.prisma.$transaction([
			this.prisma.telemetryEvent.deleteMany(),
			this.prisma.telemetryIngestionMetric.deleteMany(),
		]);
	}

	getStorageKind(): 'postgresql' {
		return 'postgresql';
	}

	async isConnected(): Promise<boolean> {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			return true;
		} catch {
			return false;
		}
	}

	private async upsertMetrics(update: {
		validationFailureIncrement?: number;
		insertFailureIncrement?: number;
		lastConsumedEventAt?: Date;
	}) {
		await this.prisma.telemetryIngestionMetric.upsert({
			where: { id: METRIC_ID },
			create: {
				id: METRIC_ID,
				validationFailureCount: update.validationFailureIncrement ?? 0,
				insertFailureCount: update.insertFailureIncrement ?? 0,
				lastConsumedEventAt: update.lastConsumedEventAt,
			},
			update: {
				...(update.validationFailureIncrement
					? {
							validationFailureCount: {
								increment: update.validationFailureIncrement,
							},
						}
					: {}),
				...(update.insertFailureIncrement
					? {
							insertFailureCount: {
								increment: update.insertFailureIncrement,
							},
						}
					: {}),
				...(update.lastConsumedEventAt
					? { lastConsumedEventAt: update.lastConsumedEventAt }
					: {}),
			},
		});
	}
}

function toTelemetryEventWhere(
	query: EventListQuery,
): Prisma.TelemetryEventWhereInput {
	const search = query.search?.trim();
	return {
		AND: [
			{
				eventType: query.eventType,
				sourceApp: query.sourceApp,
				clientServiceId: query.clientServiceId,
				clientServiceSlug: query.clientServiceSlug,
				status: query.status,
				occurredAt:
					query.from || query.to
						? {
								gte: query.from ? new Date(query.from) : undefined,
								lte: query.to ? new Date(query.to) : undefined,
							}
						: undefined,
				path: query.path ? { contains: query.path } : undefined,
				name: query.name ? { contains: query.name } : undefined,
				imageKey: query.imageKey,
				requestId: query.requestId,
			},
			...(search
				? [
						{
							OR: searchableTelemetryFields.map((field) => ({
								[field]: { contains: search, mode: 'insensitive' as const },
							})),
						},
					]
				: []),
			...(query.cursor
				? [
						{
							OR: [
								{ occurredAt: { lt: new Date(query.cursor.occurredAt) } },
								{
									occurredAt: new Date(query.cursor.occurredAt),
									eventId: { lt: query.cursor.eventId },
								},
							],
						},
					]
				: []),
		],
	};
}

const searchableTelemetryFields = [
	'eventId',
	'eventType',
	'sourceApp',
	'clientServiceId',
	'clientServiceSlug',
	'requestId',
	'traceId',
	'path',
	'name',
	'imageKey',
	'errorCode',
	'errorMessage',
] as const;

function toCreateInput(
	event: ImageTelemetryEvent,
): Prisma.TelemetryEventCreateInput {
	return {
		eventId: event.eventId,
		eventType: event.eventType,
		sourceApp: event.sourceApp,
		environment: event.environment,
		status: event.status,
		occurredAt: new Date(event.occurredAt),
		receivedAt: new Date(event.receivedAt),
		clientService: event.clientServiceId
			? { connect: { id: event.clientServiceId } }
			: undefined,
		clientServiceSlug: event.clientServiceSlug,
		requestId: event.requestId,
		traceId: event.traceId,
		imageId: event.imageId,
		path: event.path,
		name: event.name,
		imageKey: event.imageKey,
		cacheKey: event.cacheKey,
		width: event.width,
		height: event.height,
		format: event.format,
		inputBytes: event.inputBytes,
		outputBytes: event.outputBytes,
		durationMs: event.durationMs,
		errorCode: event.errorCode,
		errorMessage: event.errorMessage,
		rawPayload: event.rawPayload as Prisma.InputJsonValue,
	};
}

function toTelemetryEvent(
	row: Prisma.TelemetryEventGetPayload<Record<string, never>>,
): ImageTelemetryEvent {
	const rawPayload = toUnknownRecord(row.rawPayload);
	return {
		schemaVersion: 1,
		eventId: row.eventId,
		eventType: row.eventType as ImageTelemetryEvent['eventType'],
		occurredAt: row.occurredAt.toISOString(),
		receivedAt: row.receivedAt.toISOString(),
		sourceApp: row.sourceApp as ImageTelemetryEvent['sourceApp'],
		environment: row.environment as ImageTelemetryEvent['environment'],
		clientServiceId: row.clientServiceId ?? undefined,
		clientServiceSlug: row.clientServiceSlug ?? undefined,
		requestId: row.requestId ?? undefined,
		traceId: row.traceId ?? undefined,
		imageId: row.imageId ?? undefined,
		path: row.path,
		name: row.name,
		originalName: readOptionalString(rawPayload, 'originalName'),
		imageKey: row.imageKey,
		cacheKey: row.cacheKey ?? undefined,
		width: row.width ?? undefined,
		height: row.height ?? undefined,
		format: row.format as ImageTelemetryEvent['format'],
		inputBytes: row.inputBytes ?? undefined,
		outputBytes: row.outputBytes ?? undefined,
		durationMs: row.durationMs ?? undefined,
		status: row.status as ImageTelemetryEvent['status'],
		errorCode: row.errorCode ?? undefined,
		errorMessage: row.errorMessage ?? undefined,
		rawPayload,
	};
}

function toUnknownRecord(value: Prisma.JsonValue): UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as UnknownRecord)
		: {};
}

function readOptionalString(
	record: UnknownRecord,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === 'P2002'
	);
}
