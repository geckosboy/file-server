import type { Request, Response } from 'express';
import {
	attachRequestLogContext,
	createRequestLogMeta,
	getRequestLogContext,
	REQUEST_ID_RESPONSE_HEADER,
	resolveRequestLogContext,
} from './request-log-context';

const createRequest = (overrides: Partial<Request> = {}) =>
	({
		method: 'GET',
		url: '/image/sample.png',
		originalUrl: '/image/sample.png?width=100&apiKey=secret',
		headers: {},
		query: {},
		params: {},
		body: {},
		socket: { remoteAddress: '127.0.0.1' },
		...overrides,
	}) as Request;

const createResponse = () => {
	const headers: Record<string, string> = {};
	return {
		headers,
		headersSent: false,
		setHeader: (name: string, value: number | string | readonly string[]) => {
			headers[name.toLowerCase()] = Array.isArray(value)
				? value.join(',')
				: String(value);
		},
	} as unknown as Response & { headers: Record<string, string> };
};

describe('request log context', () => {
	it('요청 헤더와 clientServiceContext에서 로그 컨텍스트를 만든다', () => {
		const request = createRequest({
			headers: {
				'x-request-id': 'req-1',
				traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00',
				'user-agent': 'jest',
			},
		}) as Request & {
			clientServiceContext: {
				clientServiceId: string;
				clientServiceSlug: string;
				clientServiceName: string;
				clientServiceKeyId: string;
			};
		};
		request.clientServiceContext = {
			clientServiceId: 'service-1',
			clientServiceSlug: 'catalog-api',
			clientServiceName: 'Catalog API',
			clientServiceKeyId: 'key-1',
		};

		const context = resolveRequestLogContext(request);

		expect(context).toMatchObject({
			requestId: 'req-1',
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			clientServiceId: 'service-1',
			clientServiceSlug: 'catalog-api',
			clientServiceName: 'Catalog API',
			clientServiceKeyId: 'key-1',
			method: 'GET',
			url: '/image/sample.png?width=100&apiKey=****',
			clientIp: '127.0.0.1',
			userAgent: 'jest',
		});
	});

	it('request/response에 reqId와 response header를 붙인다', () => {
		const request = createRequest();
		const response = createResponse();
		const context = resolveRequestLogContext(request, {
			generateRequestId: () => 'generated-req',
		});

		attachRequestLogContext(request, response, context);

		expect((request as { reqId?: string }).reqId).toBe('generated-req');
		expect((response as { reqId?: string }).reqId).toBe('generated-req');
		expect(getRequestLogContext(request)).toBe(context);
		expect(response.headers[REQUEST_ID_RESPONSE_HEADER]).toBe('generated-req');
	});

	it('응답이 이미 끝난 뒤 로그 컨텍스트를 다시 붙여도 헤더를 다시 쓰지 않는다', () => {
		const request = createRequest();
		const response = createResponse() as unknown as Response & {
			headersSent: boolean;
			setHeader: jest.Mock;
		};
		response.headersSent = true;
		response.setHeader = jest.fn(() => {
			throw new Error('headers already sent');
		});
		const context = resolveRequestLogContext(request, {
			generateRequestId: () => 'generated-req',
		});

		expect(() =>
			attachRequestLogContext(request, response, context),
		).not.toThrow();
		expect(response.setHeader).not.toHaveBeenCalled();
		expect((response as { reqId?: string }).reqId).toBe('generated-req');
	});

	it('로그 메타에서 clientService 정보를 구조화한다', () => {
		const meta = createRequestLogMeta({
			requestId: 'req-1',
			clientServiceId: 'service-1',
			clientServiceSlug: 'catalog-api',
			clientServiceName: 'Catalog API',
			clientServiceKeyId: 'key-1',
		});

		expect(meta).toMatchObject({
			reqId: 'req-1',
			requestId: 'req-1',
			clientService: {
				id: 'service-1',
				slug: 'catalog-api',
				name: 'Catalog API',
				keyId: 'key-1',
			},
		});
	});
});
