export const DEFAULT_SENSITIVE_FIELDS = [
	'password',
	'passcode',
	'secret',
	'secretKey',
	'clientSecret',
	'token',
	'accessToken',
	'refreshToken',
	'apiKey',
	'authorization',
	'cookie',
	'set-cookie',
	'x-client-api-key',
] as const;

export interface MaskSensitiveDataOptions {
	sensitiveFields?: readonly string[];
	mask?: string;
	maxDepth?: number;
}

const DEFAULT_MASK = '****';
const DEFAULT_MAX_DEPTH = 3;

export function maskSensitiveData(
	value: unknown,
	options: MaskSensitiveDataOptions = {},
	depth = 0,
): unknown {
	const mask = options.mask ?? DEFAULT_MASK;
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const sensitiveFields = new Set(
		(options.sensitiveFields ?? DEFAULT_SENSITIVE_FIELDS).map((field) =>
			field.toLowerCase(),
		),
	);

	if (depth > maxDepth) return mask;
	if (value === null || value === undefined) return value;
	if (typeof value !== 'object') return value;
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Uint8Array || isStreamLike(value))
		return '[stream data]';

	if (Array.isArray(value)) {
		return value.map((item) => maskSensitiveData(item, options, depth + 1));
	}

	return Object.entries(value as Record<string, unknown>).reduce(
		(acc, [key, item]) => {
			acc[key] = sensitiveFields.has(key.toLowerCase())
				? mask
				: maskSensitiveData(item, options, depth + 1);
			return acc;
		},
		{} as Record<string, unknown>,
	);
}

function isStreamLike(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { pipe?: unknown }).pipe === 'function'
	);
}
