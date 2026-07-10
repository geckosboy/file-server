import { PrismaService } from '@file/database';
import { AppHealthService } from '../app-health.service';
import { AppConfig } from '../config/env.schema';

describe('resize readiness', () => {
	it('storage 또는 DB 장애를 ready=false dependency로 반환한다', async () => {
		const service = new AppHealthService(
			{
				STORAGE_SERVER: 'http://storage.test',
				kafkaClientBrokerList: ['kafka:9092'],
			} as AppConfig,
			{
				$queryRaw: jest.fn().mockRejectedValue(new Error('database down')),
			} as unknown as PrismaService,
		);
		jest
			.spyOn(
				service as unknown as { probeKafka(): Promise<void> },
				'probeKafka',
			)
			.mockResolvedValue(undefined);
		jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}', { status: 503 }));

		await expect(service.getReady()).resolves.toMatchObject({
			ok: false,
			dependencies: {
				database: { ok: false, error: 'database down' },
				storage: {
					ok: false,
					error: 'upstream readiness returned 503',
				},
			},
			operationalMetrics: {
				auth: {
					externalApiKeyDenials: expect.any(Number),
					internalContextDenials: expect.any(Number),
					authorizationDenials: expect.any(Number),
					rateLimitRejections: expect.any(Number),
				},
				telemetryProducer: {
					topic: expect.any(String),
					acknowledgements: 'all',
					maxRetries: expect.any(Number),
					deliveryFailureCount: expect.any(Number),
				},
			},
		});
		jest.restoreAllMocks();
	});

	it('DB가 hang해도 health probe deadline 안에 ready=false를 반환한다', async () => {
		const originalTimeout = process.env.HEALTH_PROBE_TIMEOUT_MS;
		process.env.HEALTH_PROBE_TIMEOUT_MS = '10';
		const service = new AppHealthService(
			{
				STORAGE_SERVER: 'http://storage.test',
				kafkaClientBrokerList: ['kafka:9092'],
			} as AppConfig,
			{
				$queryRaw: jest.fn(() => new Promise(() => undefined)),
			} as unknown as PrismaService,
		);
		jest
			.spyOn(
				service as unknown as { probeKafka(): Promise<void> },
				'probeKafka',
			)
			.mockResolvedValue(undefined);
		jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}', { status: 200 }));

		await expect(service.getReady()).resolves.toMatchObject({
			ok: false,
			dependencies: { database: { ok: false } },
		});

		if (originalTimeout === undefined)
			delete process.env.HEALTH_PROBE_TIMEOUT_MS;
		else process.env.HEALTH_PROBE_TIMEOUT_MS = originalTimeout;
		jest.restoreAllMocks();
	});
});
