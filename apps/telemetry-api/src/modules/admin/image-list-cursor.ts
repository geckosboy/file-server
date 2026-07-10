import { BadRequestException } from '@nestjs/common';
import type { ImageFilter } from '../telemetry/telemetry.types';

const CURSOR_PREFIX = 'img.v1.';
const MAX_CURSOR_LENGTH = 2048;
const MAX_IMAGE_KEY_LENGTH = 2048;

export type ImageSortField = NonNullable<ImageFilter['sort']>;
export type ImageSortOrder = NonNullable<ImageFilter['order']>;

export interface ImageListCursor {
	sort: ImageSortField;
	order: ImageSortOrder;
	sortValue: number | string;
	imageKey: string;
}

export interface ParsedImageListCursor {
	cursor?: ImageListCursor;
	offset?: number;
}

export function encodeImageListCursor(
	cursor: ImageListCursor | undefined,
): string | undefined {
	if (!cursor) {
		return undefined;
	}

	const payload = JSON.stringify({ v: 1, ...cursor });
	return `${CURSOR_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export function parseImageListCursor(
	value: string | undefined,
	expectedSort: ImageSortField,
	expectedOrder: ImageSortOrder,
): ParsedImageListCursor {
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
		if (!isImageListCursorPayload(payload)) {
			throw new Error('invalid cursor payload');
		}
		if (payload.sort !== expectedSort || payload.order !== expectedOrder) {
			throw new Error('cursor query mismatch');
		}

		return {
			cursor: {
				sort: payload.sort,
				order: payload.order,
				sortValue: payload.sortValue,
				imageKey: payload.imageKey,
			},
		};
	} catch {
		throw new BadRequestException('cursor must be a valid opaque image cursor');
	}
}

function isImageListCursorPayload(value: unknown): value is {
	v: 1;
	sort: ImageSortField;
	order: ImageSortOrder;
	sortValue: number | string;
	imageKey: string;
} {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 5 ||
		record.v !== 1 ||
		!isImageSortField(record.sort) ||
		(record.order !== 'asc' && record.order !== 'desc') ||
		typeof record.imageKey !== 'string' ||
		record.imageKey.length === 0 ||
		record.imageKey.length > MAX_IMAGE_KEY_LENGTH
	) {
		return false;
	}

	return record.sort === 'lastSeenAt'
		? typeof record.sortValue === 'string' &&
				Number.isFinite(new Date(record.sortValue).getTime())
		: typeof record.sortValue === 'number' &&
				Number.isSafeInteger(record.sortValue) &&
				record.sortValue >= 0;
}

function isImageSortField(value: unknown): value is ImageSortField {
	return ['reads', 'resizes', 'cacheMisses', 'failures', 'lastSeenAt'].includes(
		String(value),
	);
}
