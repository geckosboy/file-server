import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@file/database';
import { UnknownRecord } from '../telemetry/telemetry.types';
import { ImageLifecycleEvent, LifecycleMetrics } from './lifecycle.types';
import { LifecycleRepository } from './lifecycle.repository';

const METRIC_ID = 'default';

@Injectable()
export class PrismaLifecycleRepository implements LifecycleRepository {
	constructor(private readonly prisma: PrismaService) {}

	async insertEvent(
		event: ImageLifecycleEvent,
	): Promise<{ inserted: boolean }> {
		try {
			await this.prisma.imageLifecycleEvent.create({
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

	async getMetrics(): Promise<LifecycleMetrics> {
		const metrics = await this.prisma.imageLifecycleIngestionMetric.findUnique({
			where: { id: METRIC_ID },
		});

		return {
			validationFailureCount: metrics?.validationFailureCount ?? 0,
			insertFailureCount: metrics?.insertFailureCount ?? 0,
			lastConsumedEventAt: metrics?.lastConsumedEventAt?.toISOString() ?? null,
		};
	}

	async listEvents(): Promise<ImageLifecycleEvent[]> {
		const rows = await this.prisma.imageLifecycleEvent.findMany({
			orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }],
		});
		return rows.map(toLifecycleEvent);
	}

	async clear(): Promise<void> {
		await this.prisma.$transaction([
			this.prisma.imageLifecycleEvent.deleteMany(),
			this.prisma.imageLifecycleIngestionMetric.deleteMany(),
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
		await this.prisma.imageLifecycleIngestionMetric.upsert({
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

function toCreateInput(
	event: ImageLifecycleEvent,
): Prisma.ImageLifecycleEventCreateInput {
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
		format: event.format,
		inputBytes: event.inputBytes,
		outputBytes: event.outputBytes,
		durationMs: event.durationMs,
		errorCode: event.errorCode,
		errorMessage: event.errorMessage,
		rawPayload: event.rawPayload as Prisma.InputJsonValue,
	};
}

function toLifecycleEvent(
	row: Prisma.ImageLifecycleEventGetPayload<Record<string, never>>,
): ImageLifecycleEvent {
	const rawPayload = toUnknownRecord(row.rawPayload);
	return {
		schemaVersion: 1,
		eventId: row.eventId,
		eventType: row.eventType as ImageLifecycleEvent['eventType'],
		occurredAt: row.occurredAt.toISOString(),
		receivedAt: row.receivedAt.toISOString(),
		sourceApp: row.sourceApp as ImageLifecycleEvent['sourceApp'],
		environment: row.environment as ImageLifecycleEvent['environment'],
		clientServiceId: row.clientServiceId ?? undefined,
		clientServiceSlug: row.clientServiceSlug ?? undefined,
		requestId: row.requestId ?? undefined,
		traceId: row.traceId ?? undefined,
		imageId: row.imageId ?? undefined,
		path: row.path,
		name: row.name,
		originalName: readOptionalString(rawPayload, 'originalName'),
		imageKey: row.imageKey,
		format: row.format as ImageLifecycleEvent['format'],
		inputBytes: row.inputBytes ?? undefined,
		outputBytes: row.outputBytes ?? undefined,
		durationMs: row.durationMs ?? undefined,
		status: row.status as ImageLifecycleEvent['status'],
		errorCode: row.errorCode ?? undefined,
		errorMessage: row.errorMessage ?? undefined,
		rawPayload,
	} as ImageLifecycleEvent;
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
