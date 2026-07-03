import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const KEY_PREFIX_BYTES = 6;
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
		.update(process.env.CLIENT_API_KEY_PEPPER ?? '')
		.update(apiKey)
		.digest('hex');

export const extractClientApiKeyPrefix = (apiKey: string): string | null => {
	const [, keyPrefix] = apiKey.split('_');
	return keyPrefix || null;
};

export const isSameClientApiKeyHash = (
	leftHash: string,
	rightHash: string,
): boolean => {
	const left = Buffer.from(leftHash, 'hex');
	const right = Buffer.from(rightHash, 'hex');
	return left.length === right.length && timingSafeEqual(left, right);
};
