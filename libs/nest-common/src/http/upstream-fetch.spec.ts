import {
	BadGatewayException,
	ForbiddenException,
	GatewayTimeoutException,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException,
} from '@nestjs/common';
import {
	fetchUpstreamBuffer,
	getUpstreamFetchMetricsSnapshot,
	resetUpstreamFetchMetricsForTesting,
} from './upstream-fetch';

describe('fetchUpstreamBuffer', () => {
	let fetchSpy: jest.SpiedFunction<typeof fetch>;

	beforeEach(() => {
		resetUpstreamFetchMetricsForTesting();
		fetchSpy = jest.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('transient GET 실패만 bounded retry하고 correlation header를 전달한다', async () => {
		fetchSpy
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(
				new Response(new Uint8Array(Buffer.from('image')), { status: 200 }),
			);

		const result = await fetchUpstreamBuffer({
			upstream: 'resize',
			url: 'http://upstream.test/image',
			headers: { 'x-internal-api-key': 'internal' },
			requestContext: { requestId: 'req-1', traceId: 'trace-1' },
			maxRetries: 1,
			retryBackoffMs: 0,
		});

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const init = fetchSpy.mock.calls[1][1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(init.method).toBe('GET');
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(headers.get('x-internal-api-key')).toBe('internal');
		expect(headers.get('x-request-id')).toBe('req-1');
		expect(headers.get('x-trace-id')).toBe('trace-1');
		expect(result.body.equals(Buffer.from('image'))).toBe(true);
		expect(getUpstreamFetchMetricsSnapshot()).toEqual({
			resize: {
				requestCount: 1,
				timeoutCount: 0,
				transportFailureCount: 0,
				finalStatusCounts: { '200': 1 },
			},
			storage: {
				requestCount: 0,
				timeoutCount: 0,
				transportFailureCount: 0,
				finalStatusCounts: {},
			},
		});
	});

	it.each([
		[401, UnauthorizedException, 401],
		[403, ForbiddenException, 403],
		[404, NotFoundException, 404],
		[408, GatewayTimeoutException, 504],
		[504, GatewayTimeoutException, 504],
		[500, BadGatewayException, 502],
		[502, BadGatewayException, 502],
		[503, ServiceUnavailableException, 503],
	] as const)(
		'final upstream %i 상태를 정확한 예외와 status metric으로 남긴다',
		async (upstreamStatus, Exception, expectedStatus) => {
			fetchSpy.mockResolvedValue(
				new Response(null, { status: upstreamStatus }),
			);

			const request = fetchUpstreamBuffer({
				upstream: 'storage',
				url: 'http://upstream.test/status',
				maxRetries: 0,
			});
			await expect(request).rejects.toBeInstanceOf(Exception);
			await expect(request).rejects.toMatchObject({ status: expectedStatus });
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(getUpstreamFetchMetricsSnapshot().storage).toEqual({
				requestCount: 1,
				timeoutCount: upstreamStatus === 408 || upstreamStatus === 504 ? 1 : 0,
				transportFailureCount: 0,
				finalStatusCounts: { [String(upstreamStatus)]: 1 },
			});
		},
	);

	it('전체 deadline이 지나면 504로 종료한다', async () => {
		fetchSpy.mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal;
					signal?.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					});
				}),
		);

		await expect(
			fetchUpstreamBuffer({
				upstream: 'storage',
				url: 'http://upstream.test/hung',
				timeoutMs: 20,
				maxRetries: 1,
				retryBackoffMs: 0,
			}),
		).rejects.toBeInstanceOf(GatewayTimeoutException);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(getUpstreamFetchMetricsSnapshot().storage).toEqual({
			requestCount: 1,
			timeoutCount: 1,
			transportFailureCount: 0,
			finalStatusCounts: {},
		});
	});

	it('retry를 소진한 transport 실패를 논리 요청 단위로 한 번만 집계한다', async () => {
		fetchSpy.mockRejectedValue(new TypeError('connection reset'));

		await expect(
			fetchUpstreamBuffer({
				upstream: 'resize',
				url: 'http://upstream.test/reset',
				maxRetries: 1,
				retryBackoffMs: 0,
			}),
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(getUpstreamFetchMetricsSnapshot().resize).toEqual({
			requestCount: 1,
			timeoutCount: 0,
			transportFailureCount: 1,
			finalStatusCounts: {},
		});
	});

	it('content-length 없이 streaming되는 응답도 byte limit을 강제한다', async () => {
		fetchSpy.mockResolvedValue(
			new Response(new Uint8Array(Buffer.from('too-large')), { status: 200 }),
		);

		await expect(
			fetchUpstreamBuffer({
				upstream: 'resize',
				url: 'http://upstream.test/large',
				maxResponseBytes: 4,
			}),
		).rejects.toBeInstanceOf(BadGatewayException);
		expect(getUpstreamFetchMetricsSnapshot().resize.finalStatusCounts).toEqual({
			'200': 1,
		});
	});
});
