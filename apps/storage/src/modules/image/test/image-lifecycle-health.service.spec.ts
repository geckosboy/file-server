import { PrismaService } from '@file/database';
import { ImageLifecycleHealthService } from '../image-lifecycle-health.service';
import { ImageLifecycleMetricsService } from '../image-lifecycle-metrics.service';

describe('Image lifecycle health', () => {
	it('uses TitleCase PostgreSQL enums and recent/active failures for readiness', async () => {
		const queryRaw = jest
			.fn()
			.mockResolvedValueOnce([
				{
					pending: 0,
					ready: 10,
					deleting: 0,
					deleted: 2,
					failed: 99,
					recentFailed: 0,
					oldestActiveAgeMs: null,
				},
			])
			.mockResolvedValueOnce([
				{
					pending: 0,
					ready: 3,
					deleting: 1,
					deleted: 1,
					failed: 50,
					recentFailed: 0,
					oldestActiveAgeMs: 1_000,
				},
			])
			.mockResolvedValueOnce([
				{
					pending: 0,
					processing: 0,
					completed: 3,
					failed: 100,
					recentFailed: 0,
					cancelled: 4,
					oldestActiveAgeMs: null,
				},
			]);
		const service = new ImageLifecycleHealthService(
			{ $queryRaw: queryRaw } as unknown as PrismaService,
			new ImageLifecycleMetricsService(),
			{
				getMetricsSnapshot: jest.fn().mockResolvedValue({
					supported: true,
					lastRunAt: new Date().toISOString(),
				}),
			},
		);

		const result = await service.getMetrics();

		expect(result).toEqual(
			expect.objectContaining({
				supported: true,
				ready: true,
				variants: expect.objectContaining({ deleting: 1, failed: 50 }),
				jobs: expect.objectContaining({ failed: 100, recentFailed: 0 }),
				reconciliation: expect.objectContaining({ supported: true }),
			}),
		);
		const sql = queryRaw.mock.calls.map(([strings]) =>
			(strings as TemplateStringsArray).join(''),
		);
		expect(sql[0]).toContain("status = 'Pending'");
		expect(sql[0]).toContain("status = 'Failed'");
		expect(sql[0]).toContain("WHEN status = 'Pending' THEN created_at");
		expect(sql[0]).toContain(
			"WHEN status = 'Deleting' THEN COALESCE(deleting_at, updated_at)",
		);
		expect(sql[1]).toContain("status = 'Deleting'");
		expect(sql[1]).toContain("WHEN status = 'Pending' THEN created_at");
		expect(sql[2]).toContain("status IN ('Pending', 'Processing')");
		expect(sql[2]).not.toContain(
			"status IN ('Pending', 'Processing', 'Failed')",
		);
	});

	it('marks readiness false when Pending or Deleting state exceeds the reconciliation SLA', async () => {
		const queryRaw = jest
			.fn()
			.mockResolvedValueOnce([
				{
					pending: 1,
					ready: 0,
					deleting: 0,
					deleted: 0,
					failed: 0,
					recentFailed: 0,
					oldestActiveAgeMs: 5 * 60_000 + 1,
				},
			])
			.mockResolvedValueOnce([
				{
					pending: 0,
					ready: 0,
					deleting: 0,
					deleted: 0,
					failed: 0,
					recentFailed: 0,
					oldestActiveAgeMs: null,
				},
			])
			.mockResolvedValueOnce([
				{
					pending: 0,
					processing: 0,
					completed: 0,
					failed: 0,
					recentFailed: 0,
					cancelled: 0,
					oldestActiveAgeMs: null,
				},
			]);
		const service = new ImageLifecycleHealthService(
			{ $queryRaw: queryRaw } as unknown as PrismaService,
			new ImageLifecycleMetricsService(),
			{
				getMetricsSnapshot: jest.fn().mockResolvedValue({
					supported: true,
					lastRunAt: new Date().toISOString(),
				}),
			},
		);

		await expect(service.getMetrics()).resolves.toEqual(
			expect.objectContaining({ ready: false }),
		);
	});

	it('returns a concrete unsupported reconciliation object on query failure', async () => {
		const service = new ImageLifecycleHealthService(
			{
				$queryRaw: jest.fn().mockRejectedValue(new Error('relation missing')),
			} as unknown as PrismaService,
			new ImageLifecycleMetricsService(),
			{ getMetricsSnapshot: jest.fn().mockResolvedValue({ supported: true }) },
		);

		await expect(service.getMetrics()).resolves.toEqual(
			expect.objectContaining({
				supported: false,
				ready: false,
				reconciliation: { supported: false },
			}),
		);
	});
});
