import { NextRequest } from 'next/server';
import { GET as getLive } from '../live/route';
import { GET as getReady } from '../ready/route';
import { getTelemetryReadyUrl } from '@/lib/admin-health';

describe('admin-web health routes', () => {
	const originalBaseUrl = process.env.TELEMETRY_API_BASE_URL;
	const originalTimeout = process.env.ADMIN_WEB_HEALTH_TIMEOUT_MS;
	const originalToken = process.env.TELEMETRY_ADMIN_TOKEN;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;

	beforeEach(() => {
		process.env.TELEMETRY_API_BASE_URL = 'http://telemetry.test/api/admin/';
		process.env.ADMIN_WEB_HEALTH_TIMEOUT_MS = '20';
		process.env.TELEMETRY_ADMIN_TOKEN = 'must-not-forward';
		fetchSpy = jest.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		restoreEnv('TELEMETRY_API_BASE_URL', originalBaseUrl);
		restoreEnv('ADMIN_WEB_HEALTH_TIMEOUT_MS', originalTimeout);
		restoreEnv('TELEMETRY_ADMIN_TOKEN', originalToken);
		jest.restoreAllMocks();
	});

	it('liveness는 dependency를 호출하지 않고 process 상태만 반환한다', async () => {
		const response = getLive();

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			service: 'admin-web',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('admin API base URL에서 telemetry readiness URL을 안전하게 만든다', () => {
		expect(getTelemetryReadyUrl().toString()).toBe(
			'http://telemetry.test/health/ready',
		);
	});

	it('readiness가 correlation ID만 전달하고 관리자 credential은 전달하지 않는다', async () => {
		fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
		const request = new NextRequest('http://admin.test/health/ready', {
			headers: {
				authorization: 'Bearer inbound-secret',
				'x-file-admin-proxy-secret': 'proxy-secret',
				'x-request-id': 'req-health-1',
				'x-trace-id': 'trace-health-1',
			},
		});

		const response = await getReady(request);

		expect(response.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledWith(
			new URL('http://telemetry.test/health/ready'),
			expect.objectContaining({
				method: 'GET',
				signal: expect.any(AbortSignal),
			}),
		);
		const options = fetchSpy.mock.calls[0][1] as RequestInit;
		const headers = new Headers(options.headers);
		expect(headers.get('x-request-id')).toBe('req-health-1');
		expect(headers.get('x-trace-id')).toBe('trace-health-1');
		expect(headers.get('authorization')).toBeNull();
		expect(headers.get('x-file-admin-proxy-secret')).toBeNull();
		expect(JSON.stringify([...headers])).not.toContain('must-not-forward');
	});

	it('telemetry readiness 실패를 404가 아닌 503으로 유지한다', async () => {
		fetchSpy.mockResolvedValue(new Response('{}', { status: 503 }));

		const response = await getReady(
			new NextRequest('http://admin.test/health/ready'),
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			dependencies: {
				telemetryApi: {
					ok: false,
					reason: 'dependency_status',
					status: 503,
				},
			},
		});
	});

	it('telemetry readiness hang을 설정 deadline 뒤 503으로 종료한다', async () => {
		fetchSpy.mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal;
					signal?.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					});
				}),
		);

		const response = await getReady(
			new NextRequest('http://admin.test/health/ready'),
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			dependencies: { telemetryApi: { reason: 'timeout' } },
		});
	});

	it('credential이 포함되거나 잘못된 base URL은 fetch 없이 503이다', async () => {
		process.env.TELEMETRY_API_BASE_URL =
			'http://admin:secret@telemetry.test/api/admin';

		const response = await getReady(
			new NextRequest('http://admin.test/health/ready'),
		);

		expect(response.status).toBe(503);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}
