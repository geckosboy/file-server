import { BadRequestException } from '@nestjs/common';
import { EventListCursor } from '../telemetry/event-list-query';

const CURSOR_PREFIX = 'v1.';
const MAX_CURSOR_LENGTH = 2048;

export interface ParsedEventListCursor {
	cursor?: EventListCursor;
	offset?: number;
}

export function encodeEventListCursor(
	cursor: EventListCursor | undefined,
): string | undefined {
	if (!cursor) {
		return undefined;
	}

	const payload = JSON.stringify({
		v: 1,
		occurredAt: cursor.occurredAt,
		eventId: cursor.eventId,
	});
	return `${CURSOR_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export function parseEventListCursor(
	value: string | undefined,
): ParsedEventListCursor {
	if (value === undefined) {
		return {};
	}
	if (/^\d+$/.test(value)) {
		const offset = Number(value);
		if (Number.isSafeInteger(offset)) {
			return { offset };
		}
	}

	try {
		if (value.length > MAX_CURSOR_LENGTH || !value.startsWith(CURSOR_PREFIX)) {
			throw new Error('invalid cursor envelope');
		}
		const encoded = value.slice(CURSOR_PREFIX.length);
		if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
			throw new Error('invalid cursor encoding');
		}
		const payload: unknown = JSON.parse(
			Buffer.from(encoded, 'base64url').toString('utf8'),
		);
		if (!isEventListCursorPayload(payload)) {
			throw new Error('invalid cursor payload');
		}

		return {
			cursor: {
				occurredAt: payload.occurredAt,
				eventId: payload.eventId,
			},
		};
	} catch {
		throw new BadRequestException('cursor must be a valid opaque event cursor');
	}
}

function isEventListCursorPayload(
	value: unknown,
): value is { v: 1; occurredAt: string; eventId: string } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === 3 &&
		record.v === 1 &&
		typeof record.occurredAt === 'string' &&
		Number.isFinite(new Date(record.occurredAt).getTime()) &&
		typeof record.eventId === 'string' &&
		record.eventId.length > 0 &&
		record.eventId.length <= 512
	);
}
