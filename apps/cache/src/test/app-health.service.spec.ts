import { PrismaService } from '@file/database';
import { AppHealthService } from '../app-health.service';
import { AppConfig } from '../config/env.schema';

describe('cache readiness', () => {
	let databaseQuery: jest.Mock;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;
	let service: AppHealthService;

	beforeEach(() => {
		databaseQuery = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
		service = new AppHealthService(
			{
				RESIZING_SERVER: 'http://resize.test',
				kafkaClientBrokerList: ['kafka:9092'],
			} as AppConfig,
			{ $queryRaw: databaseQuery } as unknown as PrismaService,
			{
				getMetrics: () => ({ bytes: 128, evictions: 2 }),
			} as never,
			{
				getSingleflightMetrics: () => ({ inFlight: 1, waiters: 4 }),
			} as never,
		);
		jest
			.spyOn(
				service as unknown as { probeKafka(): Promise<void> },
				'probeKafka',
			)
			.mockResolvedValue(undefined);
		fetchSpy = jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}', { status: 200 }));
	});

	afterEach(() => jest.restoreAllMocks());

	it('DB, Kafka, resize가 모두 준비되면 ready다', async () => {
		await expect(service.getReady()).resolves.toMatchObject({
			ok: true,
			dependencies: {
				database: { ok: true },
				kafka: { ok: true },
				resize: { ok: true },
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
				cache: { available: true, bytes: 128, evictions: 2 },
				singleflight: { available: true, inFlight: 1, waiters: 4 },
			},
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			'http://resize.test/health/ready',
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it('resize readiness 503을 이미지 404로 바꾸지 않고 ready=false로 표시한다', async () => {
		fetchSpy.mockResolvedValue(new Response('{}', { status: 503 }));

		await expect(service.getReady()).resolves.toMatchObject({
			ok: false,
			dependencies: {
				resize: {
					ok: false,
					error: 'upstream readiness returned 503',
				},
			},
		});
	});

	it('DB가 hang해도 health probe deadline 안에 ready=false를 반환한다', async () => {
		const originalTimeout = process.env.HEALTH_PROBE_TIMEOUT_MS;
		process.env.HEALTH_PROBE_TIMEOUT_MS = '10';
		databaseQuery.mockImplementation(() => new Promise(() => undefined));

		await expect(service.getReady()).resolves.toMatchObject({
			ok: false,
			dependencies: { database: { ok: false } },
		});

		if (originalTimeout === undefined)
			delete process.env.HEALTH_PROBE_TIMEOUT_MS;
		else process.env.HEALTH_PROBE_TIMEOUT_MS = originalTimeout;
	});
});
