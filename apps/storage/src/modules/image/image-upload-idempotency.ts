import { BadRequestException } from '@nestjs/common';
import { ClientServiceAuthContext } from '@file/database';
import {
	normalizeImageStoragePath,
	normalizeSafeFileName,
} from '@file/image-contracts';
import { createHash, randomUUID } from 'crypto';

export const IMAGE_UPLOAD_IDEMPOTENCY_HEADER = 'idempotency-key';

let legacyGeneratedKeyCount = 0;

export const resolveImageUploadIdempotencyKey = (input: {
	headerValue?: string;
	clientServiceContext: ClientServiceAuthContext;
	path: string;
	originalName: string;
	externalImageId?: number;
	strict?: boolean;
}) => {
	const clientServiceId = input.clientServiceContext.clientServiceId;
	const path = normalizeImageStoragePath(input.path);
	const explicit = normalizeHeaderValue(input.headerValue);
	if (explicit) {
		return hashKey(['header', clientServiceId, explicit]);
	}
	if (input.externalImageId !== undefined) {
		return hashKey([
			'external-image',
			clientServiceId,
			path,
			String(input.externalImageId),
		]);
	}
	const requestId = input.clientServiceContext.requestId?.trim();
	if (requestId) {
		return hashKey([
			'request',
			clientServiceId,
			path,
			normalizeSafeFileName(input.originalName, 'original name'),
			requestId,
		]);
	}
	const strict =
		input.strict ?? process.env.IMAGE_UPLOAD_IDEMPOTENCY_STRICT === 'true';
	if (strict) {
		throw new BadRequestException(
			'Idempotency-Key, externalImageId 또는 requestId가 필요합니다.',
		);
	}
	legacyGeneratedKeyCount += 1;
	return hashKey(['legacy-generated', clientServiceId, randomUUID()]);
};

export const getImageUploadIdempotencyMetrics = () => ({
	legacyGeneratedKeyCount,
});

export const resetImageUploadIdempotencyMetricsForTesting = () => {
	legacyGeneratedKeyCount = 0;
};

const normalizeHeaderValue = (value?: string) => {
	const normalized = value?.trim();
	if (!normalized) {
		return undefined;
	}
	if (normalized.length > 256 || containsControlCharacter(normalized)) {
		throw new BadRequestException('Idempotency-Key 형식이 잘못되었습니다.');
	}
	return normalized;
};

const containsControlCharacter = (value: string) =>
	[...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 31 || codePoint === 127;
	});

const hashKey = (parts: string[]) =>
	`image-upload:v1:${createHash('sha256').update(parts.join('\0')).digest('hex')}`;
