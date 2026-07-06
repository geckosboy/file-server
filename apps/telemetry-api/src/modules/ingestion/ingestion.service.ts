import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { TelemetryRepository } from '../telemetry/telemetry.repository';
import { TELEMETRY_REPOSITORY } from '../telemetry/telemetry-repository.provider';
import {
	ImageFormats,
	ImageTelemetryEvent,
	ImageTelemetryEventType,
	ImageTelemetryEventTypes,
	RuntimeEnvironment,
	RuntimeEnvironments,
	SourceApp,
	SourceApps,
	TelemetryStatus,
	TelemetryStatuses,
	UnknownRecord,
} from '../telemetry/telemetry.types';

export interface IngestionResult {
	accepted: boolean;
	inserted: boolean;
	eventId?: string;
	reason?: string;
}

interface ParsedEventResult {
	ok: true;
	event: ImageTelemetryEvent;
}

interface InvalidEventResult {
	ok: false;
	reason: string;
}

type ParseResult = ParsedEventResult | InvalidEventResult;

@Injectable()
export class IngestionService {
	constructor(
		@Inject(TELEMETRY_REPOSITORY)
		private readonly repository: TelemetryRepository,
	) {}

	async ingest(
		payload: unknown,
		receivedAt: Date = new Date(),
	): Promise<IngestionResult> {
		const parsed = this.parseStandardEvent(payload, receivedAt);
		if (!parsed.ok) {
			await this.repository.recordValidationFailure();
			return {
				accepted: false,
				inserted: false,
				reason: parsed.reason,
			};
		}

		try {
			const { inserted } = await this.repository.insertEvent(parsed.event);
			return {
				accepted: true,
				inserted,
				eventId: parsed.event.eventId,
			};
		} catch {
			await this.repository.recordInsertFailure();
			return {
				accepted: false,
				inserted: false,
				eventId: parsed.event.eventId,
				reason: 'insert_failed',
			};
		}
	}

	async rejectInvalidPayload(reason: string): Promise<IngestionResult> {
		await this.repository.recordValidationFailure();
		return {
			accepted: false,
			inserted: false,
			reason,
		};
	}

	async ingestLegacyUploadResult(
		payload: unknown,
		receivedAt: Date = new Date(),
	): Promise<IngestionResult> {
		const legacyPayload = asRecord(payload);
		if (!legacyPayload) {
			await this.repository.recordValidationFailure();
			return {
				accepted: false,
				inserted: false,
				reason: 'payload must be an object',
			};
		}

		const id = readNumber(legacyPayload, 'id');
		const format = readOptionalString(legacyPayload, 'format') ?? 'unknown';
		const size = readOptionalNumber(legacyPayload, 'size');
		const exeTime = readOptionalNumber(legacyPayload, 'exeTime');
		if (id === undefined) {
			await this.repository.recordValidationFailure();
			return {
				accepted: false,
				inserted: false,
				reason: 'id is required',
			};
		}

		const path = readOptionalString(legacyPayload, 'path') ?? 'legacy/image';
		const name =
			readOptionalString(legacyPayload, 'name') ??
			`legacy-${id}.${format === 'unknown' ? 'bin' : format}`;
		const imageKey =
			readOptionalString(legacyPayload, 'imageKey') ?? `${path}/${name}`;
		return await this.ingest(
			{
				schemaVersion: 1,
				eventId:
					readOptionalString(legacyPayload, 'eventId') ?? `legacy-upload-${id}`,
				eventType: 'image.upload.completed',
				occurredAt:
					readOptionalString(legacyPayload, 'occurredAt') ??
					receivedAt.toISOString(),
				sourceApp: 'storage',
				environment:
					readOptionalString(legacyPayload, 'environment') ??
					process.env.NODE_ENV ??
					'development',
				clientServiceId: readOptionalString(legacyPayload, 'clientServiceId'),
				clientServiceSlug: readOptionalString(
					legacyPayload,
					'clientServiceSlug',
				),
				requestId: readOptionalString(legacyPayload, 'requestId'),
				traceId: readOptionalString(legacyPayload, 'traceId'),
				imageId: id,
				path,
				name,
				originalName: readOptionalString(legacyPayload, 'originalName'),
				imageKey,
				format,
				inputBytes: readOptionalNumber(legacyPayload, 'inputBytes') ?? size,
				outputBytes: readOptionalNumber(legacyPayload, 'outputBytes') ?? size,
				durationMs: readOptionalNumber(legacyPayload, 'durationMs') ?? exeTime,
				status: 'success',
			},
			receivedAt,
		);
	}

	private parseStandardEvent(payload: unknown, receivedAt: Date): ParseResult {
		const record = asRecord(payload);
		if (!record) {
			return { ok: false, reason: 'payload must be an object' };
		}

		if (record.schemaVersion !== 1) {
			return { ok: false, reason: 'schemaVersion must be 1' };
		}

		const eventId = readString(record, 'eventId');
		const eventType = readEnum(
			record,
			'eventType',
			ImageTelemetryEventTypes,
		) as ImageTelemetryEventType | undefined;
		const occurredAt = readIsoString(record, 'occurredAt');
		const sourceApp = readEnum(record, 'sourceApp', SourceApps) as
			SourceApp | undefined;
		const environment = readEnum(record, 'environment', RuntimeEnvironments) as
			RuntimeEnvironment | undefined;
		const status = readEnum(record, 'status', TelemetryStatuses) as
			TelemetryStatus | undefined;
		const path = readString(record, 'path');
		const name = readString(record, 'name');
		const imageKey = readString(record, 'imageKey');

		if (!eventId) {
			return { ok: false, reason: 'eventId is required or invalid' };
		}
		if (!eventType) {
			return { ok: false, reason: 'eventType is required or invalid' };
		}
		if (!occurredAt) {
			return { ok: false, reason: 'occurredAt is required or invalid' };
		}
		if (!sourceApp) {
			return { ok: false, reason: 'sourceApp is required or invalid' };
		}
		if (!environment) {
			return { ok: false, reason: 'environment is required or invalid' };
		}
		if (!status) {
			return { ok: false, reason: 'status is required or invalid' };
		}
		if (!path) {
			return { ok: false, reason: 'path is required or invalid' };
		}
		if (!name) {
			return { ok: false, reason: 'name is required or invalid' };
		}
		if (!imageKey) {
			return { ok: false, reason: 'imageKey is required or invalid' };
		}

		const errorCode = readOptionalString(record, 'errorCode');
		const errorMessage = readOptionalString(record, 'errorMessage');
		if (status === 'failed' && (!errorCode || !errorMessage)) {
			return {
				ok: false,
				reason: 'failed event requires errorCode and errorMessage',
			};
		}

		return {
			ok: true,
			event: {
				schemaVersion: 1,
				eventId,
				eventType,
				occurredAt,
				receivedAt:
					readOptionalIsoString(record, 'receivedAt') ??
					receivedAt.toISOString(),
				sourceApp,
				environment,
				clientServiceId: readOptionalString(record, 'clientServiceId'),
				clientServiceSlug: readOptionalString(record, 'clientServiceSlug'),
				requestId: readOptionalString(record, 'requestId'),
				traceId: readOptionalString(record, 'traceId'),
				imageId: readOptionalNumber(record, 'imageId'),
				path,
				name,
				originalName: readOptionalString(record, 'originalName'),
				imageKey,
				cacheKey: readOptionalString(record, 'cacheKey'),
				width: readOptionalNumber(record, 'width'),
				height: readOptionalNumber(record, 'height'),
				format: readEnum(record, 'format', ImageFormats),
				inputBytes: readOptionalNumber(record, 'inputBytes'),
				outputBytes: readOptionalNumber(record, 'outputBytes'),
				durationMs: readOptionalNumber(record, 'durationMs'),
				status,
				errorCode,
				errorMessage,
				rawPayload: record,
			},
		};
	}
}

function asRecord(value: unknown): UnknownRecord | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null;
	}

	return value as UnknownRecord;
}

function readString(record: UnknownRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readOptionalString(
	record: UnknownRecord,
	key: string,
): string | undefined {
	const value = record[key];
	return value === undefined ? undefined : readString(record, key);
}

function readNumber(record: UnknownRecord, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}

function readOptionalNumber(
	record: UnknownRecord,
	key: string,
): number | undefined {
	const value = record[key];
	return value === undefined ? undefined : readNumber(record, key);
}

function readIsoString(record: UnknownRecord, key: string): string | undefined {
	const value = readString(record, key);
	return value && isValidDate(value) ? value : undefined;
}

function readOptionalIsoString(
	record: UnknownRecord,
	key: string,
): string | undefined {
	const value = record[key];
	return value === undefined ? undefined : readIsoString(record, key);
}

function readEnum<TValue extends string>(
	record: UnknownRecord,
	key: string,
	allowedValues: readonly TValue[],
): TValue | undefined {
	const value = record[key];
	return typeof value === 'string' && allowedValues.includes(value as TValue)
		? (value as TValue)
		: undefined;
}
function isValidDate(value: string): boolean {
	const timestamp = new Date(value).getTime();
	return Number.isFinite(timestamp);
}
