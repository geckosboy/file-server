import { Inject, Injectable } from '@nestjs/common';
import {
	assertImageLifecycleEvent,
	validateImageLifecycleEvent,
} from '@file/telemetry-contracts/lifecycle';
import { LIFECYCLE_REPOSITORY } from './lifecycle-repository.provider';
import { LifecycleRepository } from './lifecycle.repository';
import { ImageLifecycleEvent } from './lifecycle.types';
import { UnknownRecord } from '../telemetry/telemetry.types';
import { IngestionResult } from '../ingestion/ingestion.service';

interface ParsedLifecycleEventResult {
	ok: true;
	event: ImageLifecycleEvent;
}

interface InvalidLifecycleEventResult {
	ok: false;
	reason: string;
}

type ParseResult = ParsedLifecycleEventResult | InvalidLifecycleEventResult;

@Injectable()
export class LifecycleIngestionService {
	constructor(
		@Inject(LIFECYCLE_REPOSITORY)
		private readonly repository: LifecycleRepository,
	) {}

	async ingest(
		payload: unknown,
		receivedAt: Date = new Date(),
	): Promise<IngestionResult> {
		const parsed = this.parseLifecycleEvent(payload, receivedAt);
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

	private parseLifecycleEvent(payload: unknown, receivedAt: Date): ParseResult {
		const validation = validateImageLifecycleEvent(payload);
		if (!validation.ok) {
			return { ok: false, reason: validation.errors.join(', ') };
		}

		const record = asRecord(payload) ?? {};
		return {
			ok: true,
			event: assertImageLifecycleEvent({
				...validation.event,
				receivedAt:
					readOptionalIsoString(record, 'receivedAt') ??
					receivedAt.toISOString(),
				rawPayload: record,
			}) as ImageLifecycleEvent,
		};
	}
}

function asRecord(value: unknown): UnknownRecord | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null;
	}

	return value as UnknownRecord;
}

function readOptionalIsoString(
	record: UnknownRecord,
	key: string,
): string | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}

	return typeof value === 'string' && Number.isFinite(Date.parse(value))
		? value
		: undefined;
}
