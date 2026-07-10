import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

describe('admin-web proxy 경계', () => {
	const originalNodeEnv = process.env.NODE_ENV;
	const originalSecret = process.env.ADMIN_WEB_PROXY_SECRET;

	afterEach(() => {
		restoreEnv('NODE_ENV', originalNodeEnv);
		if (originalSecret === undefined) delete process.env.ADMIN_WEB_PROXY_SECRET;
		else process.env.ADMIN_WEB_PROXY_SECRET = originalSecret;
	});

	it('production에서 인증되지 않은 사용자는 401을 받는다', () => {
		setEnv('NODE_ENV', 'production');
		process.env.ADMIN_WEB_PROXY_SECRET = 'proxy-secret';

		const response = proxy(new NextRequest('http://admin.test/services'));

		expect(response.status).toBe(401);
	});

	it('올바른 reverse proxy 헤더는 actor/requestId를 내부 요청에 전달한다', () => {
		setEnv('NODE_ENV', 'production');
		process.env.ADMIN_WEB_PROXY_SECRET = 'proxy-secret';
		const request = new NextRequest('http://admin.test/services', {
			headers: {
				'x-file-admin-proxy-secret': 'proxy-secret',
				'x-file-admin-user': 'operator@example.com',
				'x-request-id': 'req-proxy-1',
			},
		});

		const response = proxy(request);

		expect(response.status).toBe(200);
		expect(response.headers.get('x-middleware-request-x-file-admin-user')).toBe(
			'operator@example.com',
		);
		expect(response.headers.get('x-middleware-request-x-request-id')).toBe(
			'req-proxy-1',
		);
	});
});

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function setEnv(name: string, value: string) {
	process.env[name] = value;
}
