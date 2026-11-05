import { Kafka } from 'kafkajs';
import { PrismaService } from '@file/database';
import { AppHealthService } from '../app-health.service';
import { AppConfig } from '../config/env.schema';

jest.mock('kafkajs', () => ({
	Kafka: jest.fn(),
	logLevel: { NOTHING: 0 },
}));

describe('cache Kafka readiness probe', () => {
	it('probe timeout을 Kafka client에 적용하고 동시/근접 요청은 같은 snapshot을 재사용한다', async () => {
		const originalTimeout = process.env.HEALTH_PROBE_TIMEOUT_MS;
		const originalTtl = process.env.HEALTH_PROBE_CACHE_TTL_MS;
		process.env.HEALTH_PROBE_TIMEOUT_MS = '25';
		process.env.HEALTH_PROBE_CACHE_TTL_MS = '1000';
		const admin = {
			connect: jest.fn().mockResolvedValue(undefined),
			describeCluster: jest.fn().mockResolvedValue({ brokers: [] }),
			disconnect: jest.fn().mockResolvedValue(undefined),
		};
		const KafkaMock = Kafka as unknown as jest.Mock;
		KafkaMock.mockImplementation(() => ({ admin: () => admin }));
		const service = new AppHealthService(
			{ kafkaClientBrokerList: ['kafka:9092'] } as AppConfig,
			{} as PrismaService,
			{} as never,
			{} as never,
		);
		const probeKafka = (
			service as unknown as { probeKafka(): Promise<void> }
		).probeKafka.bind(service);

		await Promise.all([probeKafka(), probeKafka()]);
		await probeKafka();

		expect(KafkaMock).toHaveBeenCalledTimes(1);
		expect(KafkaMock).toHaveBeenCalledWith(
			expect.objectContaining({
				connectionTimeout: 25,
				requestTimeout: 25,
			}),
		);
		expect(admin.connect).toHaveBeenCalledTimes(1);
		expect(admin.describeCluster).toHaveBeenCalledTimes(1);
		expect(admin.disconnect).toHaveBeenCalledTimes(1);

		if (originalTimeout === undefined) {
			delete process.env.HEALTH_PROBE_TIMEOUT_MS;
		} else {
			process.env.HEALTH_PROBE_TIMEOUT_MS = originalTimeout;
		}
		if (originalTtl === undefined) {
			delete process.env.HEALTH_PROBE_CACHE_TTL_MS;
		} else {
			process.env.HEALTH_PROBE_CACHE_TTL_MS = originalTtl;
		}
		jest.restoreAllMocks();
	});
});
