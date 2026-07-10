import {
	AdminWebAuthenticationError,
	AdminWebConfigurationError,
	authenticateAdminWebHeaders,
	createAdminAuditHeaders,
} from '.././admin-auth-policy';

describe('admin-web reverse proxy 인증 정책', () => {
	it('production 설정 또는 proxy 인증 헤더가 없으면 fail-closed한다', () => {
		expect(() =>
			authenticateAdminWebHeaders(new Headers(), { NODE_ENV: 'production' }),
		).toThrow(AdminWebConfigurationError);

		expect(() =>
			authenticateAdminWebHeaders(new Headers(), {
				NODE_ENV: 'production',
				ADMIN_WEB_PROXY_SECRET: 'proxy-secret',
			}),
		).toThrow(AdminWebAuthenticationError);
	});

	it('proxy secret과 actor가 모두 맞으면 감사 컨텍스트를 만든다', () => {
		const headers = new Headers({
			'x-file-admin-proxy-secret': 'proxy-secret',
			'x-file-admin-user': 'operator@example.com',
			'x-request-id': 'req-admin-1',
		});
		const session = authenticateAdminWebHeaders(headers, {
			NODE_ENV: 'production',
			ADMIN_WEB_PROXY_SECRET: 'proxy-secret',
		});

		expect(session).toEqual({
			actor: 'operator@example.com',
			requestId: 'req-admin-1',
		});
		expect(createAdminAuditHeaders(session)).toEqual({
			'x-admin-actor': 'operator@example.com',
			'x-request-id': 'req-admin-1',
		});
	});

	it('test 환경에서만 별도 proxy 없이 fixture session을 허용한다', () => {
		expect(
			authenticateAdminWebHeaders(new Headers(), { NODE_ENV: 'test' }),
		).toMatchObject({ actor: 'local-admin', requestId: expect.any(String) });
	});
});
