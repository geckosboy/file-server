import { PrismaService } from '@file/database';
import { PrismaLifecycleRepository } from '../../lifecycle/prisma-lifecycle.repository';
import { PrismaTelemetryRepository } from '../../telemetry/prisma-telemetry.repository';
import { AdminQueryService } from '../admin-query.service';
import { PrismaAdminAnalyticsRepository } from '../prisma-admin-analytics.repository';

const describePostgres =
	process.env.STAGE3_POSTGRES_TEST === 'true' ? describe : describe.skip;
const PREFIX = 'stage3-admin-pg-';
const imageKey = `${PREFIX}products/image/sample.png`;
const range = {
	from: '2026-07-01T00:00:00.000Z',
	to: '2026-07-01T00:59:59.999Z',
};

describePostgres('Stage 3 admin PostgreSQL integration', () => {
	let prisma: PrismaService;
	let service: AdminQueryService;

	beforeAll(async () => {
		prisma = new PrismaService();
		await prisma.onModuleInit();
		const telemetry = new PrismaTelemetryRepository(prisma);
		const lifecycle = new PrismaLifecycleRepository(prisma);
		const analytics = new PrismaAdminAnalyticsRepository(prisma);
		jest
			.spyOn(telemetry, 'listEvents')
			.mockRejectedValue(new Error('unbounded telemetry read'));
		jest
			.spyOn(telemetry, 'listAssets')
			.mockRejectedValue(new Error('unbounded asset projection'));
		jest
			.spyOn(telemetry, 'listVariants')
			.mockRejectedValue(new Error('unbounded variant projection'));
		service = new AdminQueryService(telemetry, lifecycle, analytics);
	});

	beforeEach(async () => {
		await clearFixtures(prisma);
		await seedFixtures(prisma);
	});

	afterEach(async () => {
		await clearFixtures(prisma);
	});

	afterAll(async () => {
		await prisma.onModuleDestroy();
	});

	it('runs bounded event/lifecycle pages and DB analytics through the service seam', async () => {
		const firstPage = await service.listEvents({ ...range, limit: 2 });
		const secondPage = await service.listEvents({
			...range,
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		expect(firstPage.nextCursor).toMatch(/^v1\./);
		expect(
			new Set(
				[...firstPage.items, ...secondPage.items].map(({ eventId }) => eventId),
			).size,
		).toBe(4);
		await expect(
			service.listEvents({ ...range, search: 'MISSING IMAGE', limit: 10 }),
		).resolves.toMatchObject({
			items: [
				expect.objectContaining({ eventId: `${PREFIX}telemetry-failed` }),
			],
		});
		await expect(
			service.listLifecycleEvents({
				...range,
				sourceApp: 'storage',
				limit: 10,
			}),
		).resolves.toMatchObject({
			items: [
				expect.objectContaining({ eventId: `${PREFIX}lifecycle-upload` }),
			],
		});

		await expect(service.getSummary(range)).resolves.toMatchObject({
			totalEvents: 4,
			totalReads: 2,
			totalUploads: 1,
			totalResizes: 1,
		});
		await expect(
			service.getTimeseries({ ...range, interval: 'hour' }),
		).resolves.toMatchObject({
			interval: 'hour',
			points: [expect.objectContaining({ totalEvents: 4 })],
		});
		await expect(service.listImages({ limit: 10 })).resolves.toMatchObject({
			items: [expect.objectContaining({ imageKey, totalResizes: 1 })],
		});
		await expect(service.getImage(imageKey)).resolves.toMatchObject({
			imageKey,
		});
		await expect(service.listImageVariants(imageKey)).resolves.toMatchObject({
			items: [
				expect.objectContaining({
					variantKey: `${imageKey}:120x80:webp`,
					resizeCount: 1,
				}),
			],
		});
		await expect(
			service.listImageResizeRecommendations({
				...range,
				clientServiceSlug: `${PREFIX}service`,
				minRequests: 1,
				limit: 10,
			}),
		).resolves.toMatchObject({
			threshold: { minRequests: 1 },
			items: [expect.objectContaining({ requestCount: 1, recommended: true })],
		});
	});
});

async function seedFixtures(prisma: PrismaService): Promise<void> {
	await prisma.telemetryEvent.createMany({
		data: [
			telemetryRow(
				'upload',
				'image.upload.completed',
				'2026-07-01T00:00:00.000Z',
			),
			{
				...telemetryRow('hit', 'image.cache.hit', '2026-07-01T00:10:00.000Z'),
				sourceApp: 'cache',
			},
			{
				...telemetryRow(
					'resize',
					'image.resize.completed',
					'2026-07-01T00:20:00.000Z',
				),
				sourceApp: 'resize',
				width: 120,
				height: 80,
				format: 'webp',
				inputBytes: 100,
				outputBytes: 40,
			},
			{
				...telemetryRow(
					'failed',
					'image.read.failed',
					'2026-07-01T00:30:00.000Z',
				),
				status: 'failed',
				errorMessage: 'missing image',
			},
		],
	});
	await prisma.imageLifecycleEvent.create({
		data: {
			eventId: `${PREFIX}lifecycle-upload`,
			eventType: 'image.upload.completed',
			sourceApp: 'storage',
			environment: 'test',
			status: 'success',
			occurredAt: new Date('2026-07-01T00:05:00.000Z'),
			clientServiceSlug: `${PREFIX}service`,
			path: `${PREFIX}products/image`,
			name: 'sample.png',
			imageKey,
			rawPayload: {},
		},
	});
}

function telemetryRow(suffix: string, eventType: string, occurredAt: string) {
	return {
		eventId: `${PREFIX}telemetry-${suffix}`,
		eventType,
		sourceApp: 'storage',
		environment: 'test',
		status: 'success',
		occurredAt: new Date(occurredAt),
		clientServiceSlug: `${PREFIX}service`,
		path: `${PREFIX}products/image`,
		name: 'sample.png',
		imageKey,
		durationMs: 10,
		rawPayload: {},
	};
}

async function clearFixtures(prisma: PrismaService): Promise<void> {
	await prisma.$transaction([
		prisma.telemetryEvent.deleteMany({
			where: { eventId: { startsWith: PREFIX } },
		}),
		prisma.imageLifecycleEvent.deleteMany({
			where: { eventId: { startsWith: PREFIX } },
		}),
	]);
}
