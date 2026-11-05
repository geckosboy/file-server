import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';

export const REQUEST_ID_RESPONSE_HEADER = 'x-request-id' as const;
export const DEFAULT_REQUEST_ID_HEADERS = [
	'x-request-id',
	'x-correlation-id',
] as const;
export const DEFAULT_TRACE_ID_HEADERS = ['x-trace-id', 'traceparent'] as const;
export const DEFAULT_CLIENT_SERVICE_ID_HEADER = 'x-client-service-id' as const;
export const DEFAULT_CLIENT_SERVICE_SLUG_HEADER =
	'x-client-service-slug' as const;
export const DEFAULT_CLIENT_SERVICE_NAME_HEADER =
	'x-client-service-name' as const;
export const DEFAULT_CLIENT_SERVICE_KEY_ID_HEADER =
	'x-client-service-key-id' as const;

export interface RequestLogContext {
	requestId: string;
	traceId?: string;
	clientServiceId?: string;
	clientServiceSlug?: string;
	clientServiceName?: string;
	clientServiceKeyId?: string;
	method?: string;
	url?: string;
	clientIp?: string;
	userAgent?: string;
}

export interface RequestLogContextOptions {
	requestIdHeaders?: readonly string[];
	traceIdHeaders?: readonly string[];
	clientServiceIdHeader?: string;
	clientServiceSlugHeader?: string;
	clientServiceNameHeader?: string;
	clientServiceKeyIdHeader?: string;
	generateRequestId?: () => string;
	maxHeaderLength?: number;
}

export type RequestWithLogContext = Request & {
	reqId?: string;
	requestLogContext?: RequestLogContext;
	clientServiceContext?: unknown;
};

export type ResponseWithLogContext = Response & {
	reqId?: string;
	requestLogContext?: RequestLogContext;
};

const DEFAULT_HEADER_VALUE_MAX_LENGTH = 256;
const SENSITIVE_QUERY_KEYS = new Set([
	'password',
	'secret',
	'secretkey',
	'clientsecret',
	'token',
	'accesstoken',
	'refreshtoken',
	'apikey',
	'authorization',
	'cookie',
	'x-client-api-key',
]);
const QUERY_MASK = '****';

export function resolveRequestLogContext(
	request: Request,
	options: RequestLogContextOptions = {},
): RequestLogContext {
	const requestWithContext = request as RequestWithLogContext;
	const existingContext = requestWithContext.requestLogContext;
	const clientServiceContext = readClientServiceContext(requestWithContext);
	const requestIdHeaders =
		options.requestIdHeaders ?? DEFAULT_REQUEST_ID_HEADERS;
	const traceIdHeaders = options.traceIdHeaders ?? DEFAULT_TRACE_ID_HEADERS;
	const requestId =
		clientServiceContext?.requestId ??
		getHeader(request, requestIdHeaders, options.maxHeaderLength) ??
		existingContext?.requestId ??
		options.generateRequestId?.() ??
		randomUUID();

	return {
		requestId,
		traceId:
			clientServiceContext?.traceId ??
			resolveTraceId(request, traceIdHeaders, options.maxHeaderLength) ??
			existingContext?.traceId,
		clientServiceId:
			clientServiceContext?.clientServiceId ??
			getHeader(
				request,
				[options.clientServiceIdHeader ?? DEFAULT_CLIENT_SERVICE_ID_HEADER],
				options.maxHeaderLength,
			) ??
			existingContext?.clientServiceId,
		clientServiceSlug:
			clientServiceContext?.clientServiceSlug ??
			getHeader(
				request,
				[options.clientServiceSlugHeader ?? DEFAULT_CLIENT_SERVICE_SLUG_HEADER],
				options.maxHeaderLength,
			) ??
			existingContext?.clientServiceSlug,
		clientServiceName:
			clientServiceContext?.clientServiceName ??
			getHeader(
				request,
				[options.clientServiceNameHeader ?? DEFAULT_CLIENT_SERVICE_NAME_HEADER],
				options.maxHeaderLength,
			) ??
			existingContext?.clientServiceName,
		clientServiceKeyId:
			clientServiceContext?.clientServiceKeyId ??
			getHeader(
				request,
				[
					options.clientServiceKeyIdHeader ??
						DEFAULT_CLIENT_SERVICE_KEY_ID_HEADER,
				],
				options.maxHeaderLength,
			) ??
			existingContext?.clientServiceKeyId,
		method: existingContext?.method ?? request.method,
		url: sanitizeLogUrl(
			existingContext?.url ?? request.originalUrl ?? request.url,
		),
		clientIp:
			existingContext?.clientIp ??
			getClientIp(request, options.maxHeaderLength),
		userAgent:
			existingContext?.userAgent ??
			normalizeHeaderValue(
				request.headers['user-agent'],
				options.maxHeaderLength,
			),
	};
}

export function attachRequestLogContext(
	request: Request,
	response: Response,
	context: RequestLogContext,
): RequestLogContext {
	const requestWithContext = request as RequestWithLogContext;
	const responseWithContext = response as ResponseWithLogContext;
	const targetContext = requestWithContext.requestLogContext ?? context;

	Object.assign(targetContext, context);
	requestWithContext.reqId = targetContext.requestId;
	requestWithContext.requestLogContext = targetContext;
	responseWithContext.reqId = targetContext.requestId;
	responseWithContext.requestLogContext = targetContext;

	if (!response.headersSent) {
		response.setHeader(REQUEST_ID_RESPONSE_HEADER, targetContext.requestId);
	}

	return targetContext;
}

export function getRequestLogContext(
	target?: Request | Response | null,
): RequestLogContext | undefined {
	if (!target) return undefined;
	return (target as RequestWithLogContext | ResponseWithLogContext)
		.requestLogContext;
}

export function createRequestLogMeta(
	context?: RequestLogContext,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		...(context
			? {
					reqId: context.requestId,
					requestId: context.requestId,
					...(context.traceId ? { traceId: context.traceId } : {}),
					...(hasClientServiceLogContext(context)
						? {
								clientService: {
									...(context.clientServiceId
										? { id: context.clientServiceId }
										: {}),
									...(context.clientServiceSlug
										? { slug: context.clientServiceSlug }
										: {}),
									...(context.clientServiceName
										? { name: context.clientServiceName }
										: {}),
									...(context.clientServiceKeyId
										? { keyId: context.clientServiceKeyId }
										: {}),
								},
							}
						: {}),
					request: {
						method: context.method,
						url: context.url,
						clientIp: context.clientIp,
						userAgent: context.userAgent,
					},
				}
			: {}),
		...extra,
	};
}

export function sanitizeLogUrl(url: string): string {
	const [pathname, queryString] = url.split('?', 2);
	if (!queryString) return url;

	const params = new URLSearchParams(queryString);
	let changed = false;
	for (const key of Array.from(params.keys())) {
		if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
			params.set(key, QUERY_MASK);
			changed = true;
		}
	}

	return changed ? `${pathname}?${params.toString()}` : url;
}

function hasClientServiceLogContext(context: RequestLogContext): boolean {
	return Boolean(
		context.clientServiceId ||
		context.clientServiceSlug ||
		context.clientServiceName ||
		context.clientServiceKeyId,
	);
}

function readClientServiceContext(
	request: RequestWithLogContext,
): Partial<RequestLogContext> | undefined {
	if (!isRecord(request.clientServiceContext)) return undefined;

	return {
		clientServiceId: readString(request.clientServiceContext.clientServiceId),
		clientServiceSlug: readString(
			request.clientServiceContext.clientServiceSlug,
		),
		clientServiceName: readString(
			request.clientServiceContext.clientServiceName,
		),
		clientServiceKeyId: readString(
			request.clientServiceContext.clientServiceKeyId,
		),
		requestId: readString(request.clientServiceContext.requestId),
		traceId: readString(request.clientServiceContext.traceId),
	};
}

function resolveTraceId(
	request: Request,
	headerNames: readonly string[],
	maxLength?: number,
): string | undefined {
	const value = getHeader(request, headerNames, maxLength);
	if (!value) return undefined;

	// W3C traceparent: version-traceId-parentId-flags
	if (value.includes('-')) {
		return value.split('-')[1] || value;
	}

	return value;
}

function getHeader(
	request: Request,
	headerNames: readonly string[],
	maxLength = DEFAULT_HEADER_VALUE_MAX_LENGTH,
): string | undefined {
	for (const headerName of headerNames) {
		const value = normalizeHeaderValue(
			request.headers[headerName.toLowerCase()],
			maxLength,
		);
		if (value) return value;
	}

	return undefined;
}

function normalizeHeaderValue(
	value: string | string[] | undefined,
	maxLength = DEFAULT_HEADER_VALUE_MAX_LENGTH,
): string | undefined {
	const rawValue = Array.isArray(value) ? value[0] : value;
	const normalizedValue = rawValue?.trim();
	return normalizedValue ? normalizedValue.slice(0, maxLength) : undefined;
}

function getClientIp(
	request: Request,
	maxLength = DEFAULT_HEADER_VALUE_MAX_LENGTH,
): string | undefined {
	const forwardedFor = normalizeHeaderValue(
		request.headers['x-forwarded-for'],
		maxLength,
	);
	if (forwardedFor) {
		return forwardedFor.split(',')[0]?.trim();
	}

	return request.ip ?? request.socket.remoteAddress;
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
