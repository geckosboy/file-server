import { PrismaService } from '@file/database';
import { PrismaLifecycleRepository } from '../../lifecycle/prisma-lifecycle.repository';
import { PrismaTelemetryRepository } from '../../telemetry/prisma-telemetry.repository';

describe('Prisma event list repositories', () => {
	it.each([
		['telemetry', 'telemetryEvent', PrismaTelemetryRepository],
		['lifecycle', 'imageLifecycleEvent', PrismaLifecycleRepository],
	] as const)(
		'%s list query delegates bounded filters and keyset order to Prisma',
		async (_name, delegateName, Repository) => {
			const findMany = jest.fn().mockResolvedValue([]);
			const prisma = {
				[delegateName]: { findMany },
			} as unknown as PrismaService;
			const repository = new Repository(prisma);

			await repository.listEventPage({
				eventType: 'image.read.failed',
				sourceApp: 'storage',
				clientServiceId: 'service-a',
				clientServiceSlug: 'catalog-api',
				status: 'failed',
				from: '2026-07-01T00:00:00.000Z',
				to: '2026-07-02T00:00:00.000Z',
				search: 'missing image',
				path: 'products',
				name: 'sample',
				imageKey: 'products/image/sample.png',
				requestId: 'request-1',
				cursor: {
					occurredAt: '2026-07-01T12:00:00.000Z',
					eventId: 'event-2',
				},
				take: 25,
			});

			expect(findMany).toHaveBeenCalledWith({
				where: {
					AND: [
						expect.objectContaining({
							eventType: 'image.read.failed',
							sourceApp: 'storage',
							clientServiceId: 'service-a',
							clientServiceSlug: 'catalog-api',
							status: 'failed',
							imageKey: 'products/image/sample.png',
							requestId: 'request-1',
						}),
						expect.objectContaining({
							OR: expect.arrayContaining([
								{
									clientServiceSlug: {
										contains: 'missing image',
										mode: 'insensitive',
									},
								},
								{
									errorMessage: {
										contains: 'missing image',
										mode: 'insensitive',
									},
								},
							]),
						}),
						{
							OR: [
								{
									occurredAt: {
										lt: new Date('2026-07-01T12:00:00.000Z'),
									},
								},
								{
									occurredAt: new Date('2026-07-01T12:00:00.000Z'),
									eventId: { lt: 'event-2' },
								},
							],
						},
					],
				},
				orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
				take: 26,
				skip: undefined,
			});
		},
	);
});
