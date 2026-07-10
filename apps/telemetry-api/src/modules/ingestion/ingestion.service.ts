import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { TelemetryRepository } from '../telemetry/telemetry.repository';
import { TELEMETRY_REPOSITORY } from '../telemetry/telemetry-repository.provider';
import {
	ImageTelemetryEvent,
	UnknownRecord,
} from '../telemetry/telemetry.types';
import {
	createImageKey,
	getImageTelemetryEnvironment,
	normalizeImageFormat,
	validateImageTelemetryEvent,
} from '@file/telemetry-contracts/events';

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
		const format = normalizeImageFormat(
			readOptionalString(legacyPayload, 'format'),
		);
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
			readOptionalString(legacyPayload, 'imageKey') ??
			createImageKey(path, name);
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
					getImageTelemetryEnvironment(),
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
		const validated = validateImageTelemetryEvent(payload);
		if (!validated.ok) {
			return { ok: false, reason: validated.errors.join('; ') };
		}

		return {
			ok: true,
			event: {
				...validated.event,
				receivedAt: validated.event.receivedAt ?? receivedAt.toISOString(),
				rawPayload: payload as UnknownRecord,
			} as ImageTelemetryEvent,
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
