jest.mock('src/config', () => {
	class AppConfig {
		INTERNAL_API_KEY?: string;
	}

	return { AppConfig };
});

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AppConfig } from 'src/config';
import { InternalApiKeyGuard } from './internal-api-key.guard';

const createContext = (headerValue?: string): ExecutionContext =>
	({
		switchToHttp: () => ({
			getRequest: () => ({
				header: (name: string) =>
					name === 'x-internal-api-key' ? headerValue : undefined,
			}),
		}),
	}) as ExecutionContext;

describe('내부 API 키 가드', () => {
	it('INTERNAL_API_KEY가 없으면 요청을 허용한다', () => {
		const guard = new InternalApiKeyGuard({} as AppConfig);

		expect(guard.canActivate(createContext())).toBe(true);
	});

	it('내부 API 키가 일치하면 요청을 허용한다', () => {
		const guard = new InternalApiKeyGuard({
			INTERNAL_API_KEY: 'secret-key',
		} as AppConfig);

		expect(guard.canActivate(createContext('secret-key'))).toBe(true);
	});

	it('내부 API 키가 없거나 일치하지 않으면 요청을 거부한다', () => {
		const guard = new InternalApiKeyGuard({
			INTERNAL_API_KEY: 'secret-key',
		} as AppConfig);

		expect(() => guard.canActivate(createContext('wrong-key'))).toThrow(
			UnauthorizedException,
		);
	});
});
