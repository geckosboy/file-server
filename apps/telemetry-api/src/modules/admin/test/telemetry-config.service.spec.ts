import { TelemetryConfigService } from '.././telemetry-config.service';

describe('telemetry 운영 보안 설정', () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('test 환경에서만 고정 fixture token을 사용한다', () => {
		process.env.NODE_ENV = 'test';
		delete process.env.TELEMETRY_ADMIN_TOKEN;
		delete process.env.TELEMETRY_INGESTION_TOKEN;
		delete process.env.TELEMETRY_HTTP_INGESTION_ENABLED;

		const config = new TelemetryConfigService();
		expect(config.adminToken).toBe('test-admin-token');
		expect(config.ingestionToken).toBe('test-ingestion-token');
		expect(config.httpIngestionEnabled).toBe(true);
	});

	it('비-test 환경에서 admin token이 없으면 부팅 설정을 거부한다', () => {
		process.env.NODE_ENV = 'production';
		delete process.env.TELEMETRY_ADMIN_TOKEN;

		expect(() => new TelemetryConfigService()).toThrow('TELEMETRY_ADMIN_TOKEN');
	});

	it('CORS wildcard를 거부하고 명시적인 origin만 허용한다', () => {
		process.env.NODE_ENV = 'production';
		process.env.TELEMETRY_ADMIN_TOKEN = 'admin-secret';
		process.env.TELEMETRY_CORS_ORIGINS = '*';
		expect(() => new TelemetryConfigService()).toThrow(
			'TELEMETRY_CORS_ORIGINS',
		);

		process.env.TELEMETRY_CORS_ORIGINS =
			'https://admin.example.com,http://localhost:3000';
		expect(new TelemetryConfigService().corsOrigins).toEqual([
			'https://admin.example.com',
			'http://localhost:3000',
		]);
	});
});
