import {
	BadGatewayException,
	ForbiddenException,
	GatewayTimeoutException,
	HttpException,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 2_000;
export const DEFAULT_UPSTREAM_MAX_RETRIES = 1;
export const DEFAULT_UPSTREAM_RETRY_BACKOFF_MS = 100;
export const DEFAULT_UPSTREAM_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 429, 502, 503, 504]);
const FIXED_UPSTREAM_NAMES = ['resize', 'storage'] as const;

export type FixedUpstreamName = (typeof FIXED_UPSTREAM_NAMES)[number];

export interface UpstreamFetchOutcomeMetrics {
	requestCount: number;
	timeoutCount: number;
	transportFailureCount: number;
	finalStatusCounts: Readonly<Record<string, number>>;
}

export type UpstreamFetchMetricsSnapshot = Readonly<
	Record<FixedUpstreamName, UpstreamFetchOutcomeMetrics>
>;

const upstreamFetchMetrics: Record<
	FixedUpstreamName,
	{
		requestCount: number;
		timeoutCount: number;
		transportFailureCount: number;
		finalStatusCounts: Record<string, number>;
	}
> = createEmptyUpstreamFetchMetrics();

export interface UpstreamRequestContext {
	requestId: string;
	traceId?: string;
}

export interface FetchUpstreamBufferOptions {
	upstream: FixedUpstreamName;
	url: string;
	headers?: HeadersInit;
	requestContext?: UpstreamRequestContext;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxRetries?: number;
	retryBackoffMs?: number;
	maxResponseBytes?: number;
}

export interface UpstreamBufferResponse {
	response: Response;
	body: Buffer;
}

/** Returns a defensive copy of process-local counters with fixed upstream labels. */
export function getUpstreamFetchMetricsSnapshot(): UpstreamFetchMetricsSnapshot {
	return {
		resize: cloneUpstreamMetrics(upstreamFetchMetrics.resize),
		storage: cloneUpstreamMetrics(upstreamFetchMetrics.storage),
	};
}

export function resetUpstreamFetchMetricsForTesting(): void {
	for (const upstream of FIXED_UPSTREAM_NAMES) {
		upstreamFetchMetrics[upstream] = createEmptyOutcomeMetrics();
	}
}

/**
 * Fetches a bounded upstream GET response under one total deadline.
 *
 * Retries are deliberately limited to safe GETs and transient failures. The
 * caller-provided abort signal is composed with the total upstream deadline so
 * request cancellation also tears down the active fetch/body stream.
 */
export async function fetchUpstreamBuffer(
	options: FetchUpstreamBufferOptions,
): Promise<UpstreamBufferResponse> {
	const upstream = normalizeFixedUpstreamName(options.upstream);
	const timeoutMs = normalizePositiveInteger(
		options.timeoutMs,
		DEFAULT_UPSTREAM_TIMEOUT_MS,
		'timeoutMs',
	);
	const maxRetries = normalizeNonNegativeInteger(
		options.maxRetries,
		DEFAULT_UPSTREAM_MAX_RETRIES,
		'maxRetries',
	);
	const retryBackoffMs = normalizeNonNegativeInteger(
		options.retryBackoffMs,
		DEFAULT_UPSTREAM_RETRY_BACKOFF_MS,
		'retryBackoffMs',
	);
	const maxResponseBytes = normalizePositiveInteger(
		options.maxResponseBytes,
		DEFAULT_UPSTREAM_MAX_RESPONSE_BYTES,
		'maxResponseBytes',
	);
	const deadlineSignal = AbortSignal.timeout(timeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, deadlineSignal])
		: deadlineSignal;
	const headers = createForwardHeaders(options.headers, options.requestContext);
	incrementCounter(upstreamFetchMetrics[upstream], 'requestCount');

	for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
		let response: Response | undefined;
		let responseStatusRecorded = false;
		try {
			response = await fetch(options.url, {
				method: 'GET',
				headers,
				signal,
			});

			if (
				RETRYABLE_UPSTREAM_STATUSES.has(response.status) &&
				attempt < maxRetries
			) {
				await cancelResponseBody(response);
				await waitForRetry(retryBackoffMs, signal);
				continue;
			}

			if (!response.ok) {
				recordFinalStatus(upstream, response.status);
				responseStatusRecorded = true;
				if (response.status === 408 || response.status === 504) {
					incrementCounter(upstreamFetchMetrics[upstream], 'timeoutCount');
				}
				throw mapUpstreamStatus(response.status);
			}
			const body = await readBoundedResponseBody(response, maxResponseBytes);
			recordFinalStatus(upstream, response.status);
			responseStatusRecorded = true;

			return {
				response,
				body,
			};
		} catch (error) {
			if (error instanceof HttpException) {
				if (response && !responseStatusRecorded) {
					recordFinalStatus(upstream, response.status);
				}
				throw error;
			}
			if (options.signal?.aborted) {
				throw normalizeAbortReason(options.signal.reason, error);
			}
			if (deadlineSignal.aborted) {
				if (response && !responseStatusRecorded) {
					recordFinalStatus(upstream, response.status);
				}
				incrementCounter(upstreamFetchMetrics[upstream], 'timeoutCount');
				throw new GatewayTimeoutException(
					'업스트림 이미지 요청 시간이 초과되었습니다.',
				);
			}
			if (attempt < maxRetries) {
				await cancelResponseBody(response);
				await waitForRetry(retryBackoffMs, signal);
				continue;
			}
			if (response && !responseStatusRecorded) {
				recordFinalStatus(upstream, response.status);
			}
			incrementCounter(upstreamFetchMetrics[upstream], 'transportFailureCount');
			throw new ServiceUnavailableException(
				'업스트림 이미지 서버에 연결할 수 없습니다.',
			);
		}
	}

	throw new ServiceUnavailableException(
		'업스트림 이미지 서버에 연결할 수 없습니다.',
	);
}

function createEmptyUpstreamFetchMetrics() {
	return {
		resize: createEmptyOutcomeMetrics(),
		storage: createEmptyOutcomeMetrics(),
	};
}

function createEmptyOutcomeMetrics() {
	return {
		requestCount: 0,
		timeoutCount: 0,
		transportFailureCount: 0,
		finalStatusCounts: {} as Record<string, number>,
	};
}

function cloneUpstreamMetrics(
	metrics: (typeof upstreamFetchMetrics)[FixedUpstreamName],
): UpstreamFetchOutcomeMetrics {
	return {
		requestCount: metrics.requestCount,
		timeoutCount: metrics.timeoutCount,
		transportFailureCount: metrics.transportFailureCount,
		finalStatusCounts: { ...metrics.finalStatusCounts },
	};
}

function recordFinalStatus(upstream: FixedUpstreamName, status: number) {
	const statusKey = String(status);
	const counts = upstreamFetchMetrics[upstream].finalStatusCounts;
	counts[statusKey] = incrementBounded(counts[statusKey] ?? 0);
}

function incrementCounter(
	metrics: (typeof upstreamFetchMetrics)[FixedUpstreamName],
	key: 'requestCount' | 'timeoutCount' | 'transportFailureCount',
) {
	metrics[key] = incrementBounded(metrics[key]);
}

function incrementBounded(value: number) {
	return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function normalizeFixedUpstreamName(
	upstream: FixedUpstreamName,
): FixedUpstreamName {
	if (!FIXED_UPSTREAM_NAMES.includes(upstream)) {
		throw new Error(`지원하지 않는 upstream 이름입니다: ${String(upstream)}`);
	}
	return upstream;
}

function createForwardHeaders(
	headers: HeadersInit | undefined,
	context: UpstreamRequestContext | undefined,
): Headers {
	const forwardedHeaders = new Headers(headers);
	if (context?.requestId) {
		forwardedHeaders.set('x-request-id', context.requestId);
	}
	if (context?.traceId) {
		forwardedHeaders.set('x-trace-id', context.traceId);
	}
	return forwardedHeaders;
}

async function readBoundedResponseBody(
	response: Response,
	maxResponseBytes: number,
): Promise<Buffer> {
	const contentLength = response.headers.get('content-length');
	if (contentLength !== null) {
		const declaredBytes = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
			await cancelResponseBody(response);
			throw responseTooLarge();
		}
	}

	if (!response.body) {
		return Buffer.alloc(0);
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			totalBytes += value.byteLength;
			if (totalBytes > maxResponseBytes) {
				await reader.cancel();
				throw responseTooLarge();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	return Buffer.concat(chunks, totalBytes);
}

function mapUpstreamStatus(status: number): HttpException {
	if (status === 401) {
		return new UnauthorizedException('업스트림 이미지 인증에 실패했습니다.');
	}
	if (status === 403) {
		return new ForbiddenException('업스트림 이미지 접근이 거부되었습니다.');
	}
	if (status === 404) {
		return new NotFoundException('존재하지 않는 이미지 파일입니다.');
	}
	if (status === 408 || status === 504) {
		return new GatewayTimeoutException(
			'업스트림 이미지 요청 시간이 초과되었습니다.',
		);
	}
	if (status === 503) {
		return new ServiceUnavailableException(
			'업스트림 이미지 서버를 사용할 수 없습니다.',
		);
	}
	if (status >= 400 && status < 500) {
		return new HttpException('업스트림 이미지 요청이 거부되었습니다.', status);
	}
	return new BadGatewayException(
		'업스트림 이미지 서버 응답이 올바르지 않습니다.',
	);
}

function responseTooLarge() {
	return new BadGatewayException(
		'업스트림 이미지 응답이 허용 크기를 초과했습니다.',
	);
}

async function cancelResponseBody(response?: Response) {
	try {
		await response?.body?.cancel();
	} catch {
		// The original upstream error/status remains authoritative.
	}
}

async function waitForRetry(delayMs: number, signal: AbortSignal) {
	if (signal.aborted) {
		throw normalizeAbortReason(signal.reason);
	}
	if (delayMs === 0) {
		return;
	}

	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timeout);
			resolve();
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function normalizeAbortReason(reason: unknown, fallback?: unknown): Error {
	if (reason instanceof Error) {
		return reason;
	}
	if (fallback instanceof Error) {
		return fallback;
	}
	return new Error('업스트림 이미지 요청이 취소되었습니다.');
}

function normalizePositiveInteger(
	value: number | undefined,
	fallback: number,
	field: string,
) {
	const normalized = value ?? fallback;
	if (!Number.isInteger(normalized) || normalized <= 0) {
		throw new Error(`${field}는 양의 정수여야 합니다.`);
	}
	return normalized;
}

function normalizeNonNegativeInteger(
	value: number | undefined,
	fallback: number,
	field: string,
) {
	const normalized = value ?? fallback;
	if (!Number.isInteger(normalized) || normalized < 0) {
		throw new Error(`${field}는 0 이상의 정수여야 합니다.`);
	}
	return normalized;
}
