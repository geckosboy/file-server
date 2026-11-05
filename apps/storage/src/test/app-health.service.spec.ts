import { rm } from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '@file/database';
import { AppHealthService } from '../app-health.service';
import { AppConfig } from '../config/env.schema';
import { Root } from '../enum';

describe('storage readiness', () => {
	afterEach(async () => {
		jest.restoreAllMocks();
		await rm(path.resolve(Root, '.health'), { recursive: true, force: true });
	});

	it('실제 filesystem read/write probe와 DB/Kafka가 성공하면 ready다', async () => {
		const service = new AppHealthService(
			{ kafkaClientBrokerList: ['kafka:9092'] } as AppConfig,
			{
				$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
			} as unknown as PrismaService,
		);
		jest
			.spyOn(
				service as unknown as { probeKafka(): Promise<void> },
				'probeKafka',
			)
			.mockResolvedValue(undefined);

		await expect(service.getReady()).resolves.toMatchObject({
			ok: true,
			dependencies: {
				database: { ok: true },
				kafka: { ok: true },
				filesystem: { ok: true },
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
	});

	it('DB가 hang해도 health probe deadline 안에 ready=false를 반환한다', async () => {
		const originalTimeout = process.env.HEALTH_PROBE_TIMEOUT_MS;
		process.env.HEALTH_PROBE_TIMEOUT_MS = '10';
		const service = new AppHealthService(
			{ kafkaClientBrokerList: ['kafka:9092'] } as AppConfig,
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

		await expect(service.getReady()).resolves.toMatchObject({
			ok: false,
			dependencies: { database: { ok: false } },
		});

		if (originalTimeout === undefined)
			delete process.env.HEALTH_PROBE_TIMEOUT_MS;
		else process.env.HEALTH_PROBE_TIMEOUT_MS = originalTimeout;
	});
});
