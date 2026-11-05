import { PrismaService } from '@file/database';
import { DatabaseRetentionConfig } from '../database-retention.config';
import { DatabaseRetentionService } from '../database-retention.service';

const describePostgres =
	process.env.RETENTION_POSTGRES_TEST === 'true' ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'retention-pg-test-';
const now = new Date('2026-07-10T00:00:00.000Z');

const config: DatabaseRetentionConfig = {
	enabled: false,
	intervalMs: 0,
	telemetryDays: 90,
	lifecycleDays: 365,
	adminAuditDays: 365,
	batchSize: 2,
	maxBatchesPerRun: 10,
	batchSleepMs: 0,
	lockTimeoutMs: 1_000,
};

describePostgres('database retention PostgreSQL integration', () => {
	let prisma: PrismaService;

	beforeAll(async () => {
		prisma = new PrismaService();
		await prisma.onModuleInit();
	});

	beforeEach(async () => {
		await clearFixtures(prisma);
	});

	afterEach(async () => {
		await clearFixtures(prisma);
	});

	afterAll(async () => {
		await prisma.onModuleDestroy();
	});

	it('deletes only rows strictly older than each approved cutoff and reruns to zero', async () => {
		await prisma.telemetryEvent.createMany({
			data: [
				telemetryRow('old', daysBefore(91)),
				telemetryRow('exact', daysBefore(90)),
				telemetryRow('recent', daysBefore(89)),
			],
		});
		await prisma.imageLifecycleEvent.createMany({
			data: [
				lifecycleRow('old', daysBefore(366)),
				lifecycleRow('exact', daysBefore(365)),
				lifecycleRow('recent', daysBefore(364)),
			],
		});
		await prisma.adminAuditLog.createMany({
			data: [
				auditRow('old', daysBefore(366)),
				auditRow('exact', daysBefore(365)),
				auditRow('recent', daysBefore(364)),
			],
		});
		const service = new DatabaseRetentionService(prisma, config);

		await expect(service.runRetentionCycle(now)).resolves.toEqual({
			telemetryEvents: 1,
			lifecycleEvents: 1,
			adminAuditLogs: 1,
			skipped: false,
		});
		await expect(service.runRetentionCycle(now)).resolves.toEqual({
			telemetryEvents: 0,
			lifecycleEvents: 0,
			adminAuditLogs: 0,
			skipped: false,
		});

		await expect(remainingFixtureCounts(prisma)).resolves.toEqual({
			telemetry: 2,
			lifecycle: 2,
			audit: 2,
		});
	});

	it('lets concurrent workers drain disjoint bounded batches safely', async () => {
		await prisma.telemetryEvent.createMany({
			data: Array.from({ length: 4 }, (_, index) =>
				telemetryRow(`concurrent-${index}`, daysBefore(91 + index)),
			),
		});
		const concurrentConfig = {
			...config,
			lifecycleDays: 0,
			adminAuditDays: 0,
			maxBatchesPerRun: 1,
		};
		const first = new DatabaseRetentionService(prisma, concurrentConfig);
		const second = new DatabaseRetentionService(prisma, concurrentConfig);

		const results = await Promise.all([
			first.runRetentionCycle(now),
			second.runRetentionCycle(now),
		]);

		expect(
			results.reduce((total, result) => total + result.telemetryEvents, 0),
		).toBe(4);
		await expect(
			prisma.telemetryEvent.count({
				where: { eventId: { startsWith: PREFIX } },
			}),
		).resolves.toBe(0);
	});
});

const daysBefore = (days: number) => new Date(now.getTime() - days * DAY_MS);

const telemetryRow = (suffix: string, occurredAt: Date) => ({
	eventId: `${PREFIX}telemetry-${suffix}`,
	eventType: 'image.upload.completed',
	sourceApp: 'storage',
	environment: 'test',
	status: 'success',
	occurredAt,
	path: 'retention/test/image',
	name: `${suffix}.png`,
	imageKey: `retention/test/image/${suffix}.png`,
	rawPayload: {},
});

const lifecycleRow = (suffix: string, occurredAt: Date) => ({
	eventId: `${PREFIX}lifecycle-${suffix}`,
	eventType: 'image.upload.completed',
	sourceApp: 'storage',
	environment: 'test',
	status: 'success',
	occurredAt,
	path: 'retention/test/image',
	name: `${suffix}.png`,
	imageKey: `retention/test/image/${suffix}.png`,
	rawPayload: {},
});

const auditRow = (suffix: string, createdAt: Date) => ({
	actor: 'retention-postgres-test',
	requestId: `${PREFIX}request-${suffix}`,
	action: 'retention.test',
	targetType: 'retention-fixture',
	targetId: `${PREFIX}audit-${suffix}`,
	createdAt,
});

const clearFixtures = async (prisma: PrismaService) => {
	await prisma.$transaction([
		prisma.telemetryEvent.deleteMany({
			where: { eventId: { startsWith: PREFIX } },
		}),
		prisma.imageLifecycleEvent.deleteMany({
			where: { eventId: { startsWith: PREFIX } },
		}),
		prisma.adminAuditLog.deleteMany({
			where: { targetId: { startsWith: PREFIX } },
		}),
	]);
};

const remainingFixtureCounts = async (prisma: PrismaService) => {
	const [telemetry, lifecycle, audit] = await prisma.$transaction([
		prisma.telemetryEvent.count({
			where: { eventId: { startsWith: PREFIX } },
		}),
		prisma.imageLifecycleEvent.count({
			where: { eventId: { startsWith: PREFIX } },
		}),
		prisma.adminAuditLog.count({
			where: { targetId: { startsWith: PREFIX } },
		}),
	]);
	return { telemetry, lifecycle, audit };
};
