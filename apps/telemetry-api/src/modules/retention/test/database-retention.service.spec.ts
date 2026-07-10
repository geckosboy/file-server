import { PrismaService } from '@file/database';
import { DatabaseRetentionConfig } from '../database-retention.config';
import { DatabaseRetentionService } from '../database-retention.service';

type PrismaMock = {
	$transaction: jest.Mock;
	$executeRaw: jest.Mock;
	$queryRaw: jest.Mock;
	telemetryEvent: { deleteMany: jest.Mock };
	imageLifecycleEvent: { deleteMany: jest.Mock };
	adminAuditLog: { deleteMany: jest.Mock };
	imageLifecycleOutbox: { deleteMany: jest.Mock };
};

const config: DatabaseRetentionConfig = {
	enabled: true,
	intervalMs: 0,
	telemetryDays: 90,
	lifecycleDays: 365,
	adminAuditDays: 730,
	batchSize: 2,
	maxBatchesPerRun: 2,
	batchSleepMs: 0,
	lockTimeoutMs: 500,
};

const createPrismaMock = (): PrismaMock => {
	const prisma: PrismaMock = {
		$transaction: jest.fn(),
		$executeRaw: jest.fn().mockResolvedValue(1),
		$queryRaw: jest.fn(),
		telemetryEvent: {
			deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
		},
		imageLifecycleEvent: {
			deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
		},
		adminAuditLog: {
			deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
		},
		imageLifecycleOutbox: {
			deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
		},
	};
	prisma.$transaction.mockImplementation(
		(callback: (transaction: PrismaMock) => unknown) => callback(prisma),
	);
	return prisma;
};

describe('database retention service', () => {
	it('does not schedule deletion until an owner explicitly enables it', async () => {
		jest.useFakeTimers();
		const prisma = createPrismaMock();
		const service = new DatabaseRetentionService(
			prisma as unknown as PrismaService,
			{ ...config, enabled: false, intervalMs: 100 },
		);
		const runRetentionCycle = jest.spyOn(service, 'runRetentionCycle');

		service.onModuleInit();
		await jest.advanceTimersByTimeAsync(200);

		expect(runRetentionCycle).not.toHaveBeenCalled();
		expect(prisma.$transaction).not.toHaveBeenCalled();
		service.onModuleDestroy();
		jest.useRealTimers();
	});

	it('deletes only expired ids using lock-bounded SKIP LOCKED batches', async () => {
		const prisma = createPrismaMock();
		prisma.$queryRaw
			.mockResolvedValueOnce([{ id: 'telemetry-1' }, { id: 'telemetry-2' }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: 'lifecycle-1' }])
			.mockResolvedValueOnce([{ id: 'audit-1' }]);
		prisma.telemetryEvent.deleteMany.mockResolvedValue({ count: 2 });
		prisma.imageLifecycleEvent.deleteMany.mockResolvedValue({ count: 1 });
		prisma.adminAuditLog.deleteMany.mockResolvedValue({ count: 1 });
		const service = new DatabaseRetentionService(
			prisma as unknown as PrismaService,
			config,
		);
		const now = new Date('2026-07-10T00:00:00.000Z');

		await expect(service.runRetentionCycle(now)).resolves.toEqual({
			telemetryEvents: 2,
			lifecycleEvents: 1,
			adminAuditLogs: 1,
			skipped: false,
		});

		expect(prisma.telemetryEvent.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ['telemetry-1', 'telemetry-2'] } },
		});
		expect(prisma.imageLifecycleEvent.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ['lifecycle-1'] } },
		});
		expect(prisma.adminAuditLog.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ['audit-1'] } },
		});
		expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);

		const sqlCalls = prisma.$queryRaw.mock.calls.map(([query]) => query);
		expect(sqlCalls.map((query) => query.text)).toEqual(
			expect.arrayContaining([
				expect.stringContaining('FROM "telemetry_events"'),
				expect.stringContaining('FROM "image_lifecycle_events"'),
				expect.stringContaining('FROM "admin_audit_logs"'),
			]),
		);
		expect(sqlCalls.every((query) => query.text.includes('SKIP LOCKED'))).toBe(
			true,
		);
		expect(sqlCalls.every((query) => query.text.includes('< $1'))).toBe(true);
		expect(sqlCalls[0].values).toContainEqual(
			new Date('2026-04-11T00:00:00.000Z'),
		);
	});

	it('is idempotent when no expired rows remain and never touches outbox rows', async () => {
		const prisma = createPrismaMock();
		prisma.$queryRaw.mockResolvedValue([]);
		const service = new DatabaseRetentionService(
			prisma as unknown as PrismaService,
			config,
		);

		await expect(
			service.runRetentionCycle(new Date('2026-07-10T00:00:00.000Z')),
		).resolves.toEqual({
			telemetryEvents: 0,
			lifecycleEvents: 0,
			adminAuditLogs: 0,
			skipped: false,
		});

		expect(prisma.telemetryEvent.deleteMany).not.toHaveBeenCalled();
		expect(prisma.imageLifecycleEvent.deleteMany).not.toHaveBeenCalled();
		expect(prisma.adminAuditLog.deleteMany).not.toHaveBeenCalled();
		expect(prisma.imageLifecycleOutbox.deleteMany).not.toHaveBeenCalled();
	});

	it('leaves lifecycle and audit data untouched until owners approve periods', async () => {
		const prisma = createPrismaMock();
		prisma.$queryRaw.mockResolvedValue([]);
		const service = new DatabaseRetentionService(
			prisma as unknown as PrismaService,
			{
				...config,
				lifecycleDays: 0,
				adminAuditDays: 0,
			},
		);

		await service.runRetentionCycle(new Date('2026-07-10T00:00:00.000Z'));

		expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
		expect(prisma.imageLifecycleEvent.deleteMany).not.toHaveBeenCalled();
		expect(prisma.adminAuditLog.deleteMany).not.toHaveBeenCalled();
	});

	it('skips overlapping cycles instead of multiplying database load', async () => {
		const prisma = createPrismaMock();
		let releaseQuery!: (rows: Array<{ id: string }>) => void;
		prisma.$queryRaw.mockImplementationOnce(
			() =>
				new Promise<Array<{ id: string }>>((resolve) => {
					releaseQuery = resolve;
				}),
		);
		const service = new DatabaseRetentionService(
			prisma as unknown as PrismaService,
			config,
		);

		const firstCycle = service.runRetentionCycle();
		await Promise.resolve();
		await expect(service.runRetentionCycle()).resolves.toEqual({
			telemetryEvents: 0,
			lifecycleEvents: 0,
			adminAuditLogs: 0,
			skipped: true,
		});
		releaseQuery([]);
		prisma.$queryRaw.mockResolvedValue([]);
		await firstCycle;
	});
});
