import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const KEY_PREFIX_BYTES = 6;
const KEY_PREFIX_CHARS = 8;
const KEY_SECRET_BYTES = 32;
const KEY_VERSION_PREFIX = 'fs';

export interface GeneratedClientApiKey {
	apiKey: string;
	keyPrefix: string;
	keyHash: string;
}

export const generateClientApiKey = (): GeneratedClientApiKey => {
	const keyPrefix = randomBytes(KEY_PREFIX_BYTES).toString('base64url');
	const secret = randomBytes(KEY_SECRET_BYTES).toString('base64url');
	const apiKey = `${KEY_VERSION_PREFIX}_${keyPrefix}_${secret}`;
	return {
		apiKey,
		keyPrefix,
		keyHash: hashClientApiKey(apiKey),
	};
};

export const hashClientApiKey = (apiKey: string): string =>
	createHash('sha256')
		.update(readClientApiKeyPepper())
		.update(apiKey)
		.digest('hex');

export const extractClientApiKeyPrefix = (apiKey: string): string | null => {
	const prefixStart = `${KEY_VERSION_PREFIX}_`;
	if (!apiKey.startsWith(prefixStart)) {
		return null;
	}
	const keyPrefix = apiKey.slice(
		prefixStart.length,
		prefixStart.length + KEY_PREFIX_CHARS,
	);
	const delimiter = apiKey[prefixStart.length + KEY_PREFIX_CHARS];
	return keyPrefix.length === KEY_PREFIX_CHARS && delimiter === '_'
		? keyPrefix
		: null;
};

export const isSameClientApiKeyHash = (
	leftHash: string,
	rightHash: string,
): boolean => {
	const left = Buffer.from(leftHash, 'hex');
	const right = Buffer.from(rightHash, 'hex');
	return left.length === right.length && timingSafeEqual(left, right);
};

function readClientApiKeyPepper(): string {
	const pepper = process.env.CLIENT_API_KEY_PEPPER;
	if (pepper) {
		return pepper;
	}
	if (process.env.NODE_ENV === 'test') {
		return 'test-client-api-key-pepper';
	}
	throw new Error('CLIENT_API_KEY_PEPPER 환경변수가 필요합니다.');
}
