import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LoggerMiddleware } from './logger.middleware';
import type { ResolvedLoggerConfig } from './logger.module';

type TestResponse = Response &
	EventEmitter & {
		statusCode: number;
		headers: Record<string, string>;
		headersSent: boolean;
	};

const createResponse = (): TestResponse => {
	const response = new EventEmitter() as TestResponse;
	response.statusCode = 200;
	response.headers = {};
	response.headersSent = false;
	response.setHeader = (
		name: string,
		value: number | string | readonly string[],
	) => {
		response.headers[name.toLowerCase()] = Array.isArray(value)
			? value.join(',')
			: String(value);
		return response;
	};
	return response;
};

const createRequest = () =>
	({
		method: 'POST',
		url: '/images',
		originalUrl: '/images?apiKey=query-secret',
		headers: {
			'x-request-id': 'req-upload-1',
			'x-client-api-key': 'header-secret',
			'user-agent': 'jest',
		},
		query: { apiKey: 'query-secret', width: '100' },
		params: {},
		body: {
			name: 'sample.png',
			apiKey: 'body-secret',
			nested: { authorization: 'bearer-secret' },
		},
		socket: { remoteAddress: '127.0.0.1' },
	}) as unknown as Request & {
		clientServiceContext?: {
			clientServiceId: string;
			clientServiceSlug: string;
			clientServiceName: string;
			clientServiceKeyId: string;
			requestId: string;
		};
		requestLogContext?: Record<string, unknown>;
	};

const config: ResolvedLoggerConfig = {
	appName: 'storage',
	sensitiveFields: ['password', 'apiKey', 'authorization', 'x-client-api-key'],
	mask: '****',
	includeStartLog: true,
};

describe('LoggerMiddleware', () => {
	let logSpy: jest.SpyInstance;

	beforeEach(() => {
		logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
		jest.spyOn(Logger.prototype, 'error').mockImplementation();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('참고 common-nest처럼 시작/종료 로그를 남기고 민감값과 clientService를 처리한다', () => {
		const middleware = new LoggerMiddleware(config);
		const request = createRequest();
		const response = createResponse();

		middleware.use(request, response, () => {
			request.clientServiceContext = {
				clientServiceId: 'service-1',
				clientServiceSlug: 'catalog-api',
				clientServiceName: 'Catalog API',
				clientServiceKeyId: 'key-1',
				requestId: 'req-upload-1',
			};
			Object.assign(request.requestLogContext ?? {}, {
				clientServiceId: 'service-1',
				clientServiceSlug: 'catalog-api',
				clientServiceName: 'Catalog API',
				clientServiceKeyId: 'key-1',
			});
			response.statusCode = 201;
			response.emit('finish');
		});

		const messages = logSpy.mock.calls.map(([message]) => String(message));
		expect(messages).toHaveLength(2);
		expect(messages[0]).toContain('Start!');
		expect(messages[0]).toContain('"apiKey":"****"');
		expect(messages[0]).toContain('"authorization":"****"');
		expect(messages[0]).not.toContain('query-secret');
		expect(messages[0]).not.toContain('body-secret');
		expect(messages[0]).not.toContain('bearer-secret');
		expect(messages[1]).toContain('201');
		expect(messages[1]).toContain('"slug":"catalog-api"');
		expect(response.headers['x-request-id']).toBe('req-upload-1');
	});
});
