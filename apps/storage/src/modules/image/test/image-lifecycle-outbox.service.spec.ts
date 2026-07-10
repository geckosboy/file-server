import { Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@file/database';
import { createImageCacheInvalidationEvent } from '@file/telemetry-contracts/image-operations';
import { of, throwError } from 'rxjs';
import {
	createImageLifecycleEvent,
	ImageLifecycleEventType,
	ImageLifecycleStatus,
} from '.././image.lifecycle';
import { ImageLifecycleOutboxService } from '.././image-lifecycle-outbox.service';

const event = createImageLifecycleEvent({
	eventId: 'life-outbox-1',
	eventType: ImageLifecycleEventType.UploadCompleted,
	occurredAt: '2026-07-03T00:00:00.000Z',
	environment: 'test',
	clientServiceId: 'service-1',
	clientServiceSlug: 'local-demo',
	requestId: 'req-1',
	imageId: 10,
	path: 'products/image',
	name: 'sample.png',
	format: 'png',
	inputBytes: 100,
	outputBytes: 80,
	durationMs: 12,
	status: ImageLifecycleStatus.Success,
});

const canonicalTopic = 'file.image.lifecycle.v1';
const clientTopic = 'file.image.lifecycle.client.service-1.v1';

const createOutboxRecord = (overrides: Record<string, unknown> = {}) => ({
	id: 'outbox-1',
	eventId: event.eventId,
	topic: canonicalTopic,
	kafkaKey: 'local-demo:products/image/sample.png:image.upload.completed',
	payload: event as unknown as Prisma.JsonValue,
	status: 'PENDING',
	attempts: 0,
	nextAttemptAt: new Date('2026-07-03T00:00:00.000Z'),
	leaseOwner: null,
	leaseExpiresAt: null,
	publishedAt: null,
	deadLetteredAt: null,
	lastError: null,
	createdAt: new Date('2026-07-03T00:00:00.000Z'),
	updatedAt: new Date('2026-07-03T00:00:00.000Z'),
	...overrides,
});

type PrismaMock = {
	$transaction: jest.Mock;
	$executeRaw: jest.Mock;
	$queryRaw: jest.Mock;
	clientServiceLifecycleSubscription: {
		findFirst: jest.Mock;
	};
	imageLifecycleOutbox: {
		createMany: jest.Mock;
		findMany: jest.Mock;
		updateMany: jest.Mock;
		deleteMany: jest.Mock;
	};
};

const createPrismaMock = (): PrismaMock => {
	const prisma: PrismaMock = {
		$transaction: jest.fn(),
		$executeRaw: jest.fn().mockResolvedValue(1),
		$queryRaw: jest.fn(),
		clientServiceLifecycleSubscription: {
			findFirst: jest.fn().mockResolvedValue(null),
		},
		imageLifecycleOutbox: {
			createMany: jest.fn().mockResolvedValue({ count: 1 }),
			findMany: jest.fn(),
			updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
		},
	};
	prisma.$transaction.mockImplementation(
		(callback: (transaction: PrismaMock) => unknown) => callback(prisma),
	);
	return prisma;
};

describe('이미지 lifecycle outbox 서비스', () => {
	const originalNodeEnv = process.env.NODE_ENV;
	const originalMaxAttempts = process.env.LIFECYCLE_OUTBOX_MAX_ATTEMPTS;
	const originalPublishInterval =
		process.env.LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS;
	const originalCleanupInterval =
		process.env.LIFECYCLE_OUTBOX_CLEANUP_INTERVAL_MS;
	const originalCleanupMaxBatches =
		process.env.LIFECYCLE_OUTBOX_CLEANUP_MAX_BATCHES_PER_RUN;
	const originalCleanupBatchSleep =
		process.env.LIFECYCLE_OUTBOX_CLEANUP_BATCH_SLEEP_MS;
	const originalCleanupLockTimeout =
		process.env.LIFECYCLE_OUTBOX_CLEANUP_LOCK_TIMEOUT_MS;
	const originalCacheInvalidationTopic =
		process.env.CACHE_INVALIDATION_KAFKA_TOPIC;
	let prisma: PrismaMock;
	let imageClient: jest.Mocked<Pick<ClientKafka, 'emit'>>;
	let service: ImageLifecycleOutboxService;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		delete process.env.LIFECYCLE_OUTBOX_MAX_ATTEMPTS;
		prisma = createPrismaMock();
		imageClient = {
			emit: jest.fn().mockReturnValue(of({ ok: true })),
		};
		service = new ImageLifecycleOutboxService(
			prisma as unknown as PrismaService,
			imageClient as unknown as ClientKafka,
		);
	});

	afterEach(() => {
		service.onModuleDestroy();
		jest.useRealTimers();
		process.env.NODE_ENV = originalNodeEnv;
		if (originalMaxAttempts === undefined) {
			delete process.env.LIFECYCLE_OUTBOX_MAX_ATTEMPTS;
		} else {
			process.env.LIFECYCLE_OUTBOX_MAX_ATTEMPTS = originalMaxAttempts;
		}
		restoreEnvironmentValue(
			'LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS',
			originalPublishInterval,
		);
		restoreEnvironmentValue(
			'LIFECYCLE_OUTBOX_CLEANUP_INTERVAL_MS',
			originalCleanupInterval,
		);
		restoreEnvironmentValue(
			'LIFECYCLE_OUTBOX_CLEANUP_MAX_BATCHES_PER_RUN',
			originalCleanupMaxBatches,
		);
		restoreEnvironmentValue(
			'LIFECYCLE_OUTBOX_CLEANUP_BATCH_SLEEP_MS',
			originalCleanupBatchSleep,
		);
		restoreEnvironmentValue(
			'LIFECYCLE_OUTBOX_CLEANUP_LOCK_TIMEOUT_MS',
			originalCleanupLockTimeout,
		);
		restoreEnvironmentValue(
			'CACHE_INVALIDATION_KAFKA_TOPIC',
			originalCacheInvalidationTopic,
		);
		jest.restoreAllMocks();
	});

	it('publish 조회가 실패해도 rejection을 관찰하고 다음 timer tick에서 재시도한다', async () => {
		jest.useFakeTimers();
		process.env.LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS = '100';
		process.env.LIFECYCLE_OUTBOX_CLEANUP_INTERVAL_MS = '0';
		const databaseError = new Error('database unavailable during find');
		prisma.imageLifecycleOutbox.findMany
			.mockRejectedValueOnce(databaseError)
			.mockResolvedValueOnce([]);
		const loggerError = jest
			.spyOn(Logger.prototype, 'error')
			.mockImplementation(() => undefined);

		service.onModuleInit();
		await flushPromises();

		expect(loggerError).toHaveBeenCalledWith({
			event: 'image_lifecycle_outbox_background_task_failed',
			task: 'publish',
			error: databaseError.message,
			stack: databaseError.stack,
		});
		await jest.advanceTimersByTimeAsync(100);
		expect(prisma.imageLifecycleOutbox.findMany).toHaveBeenCalledTimes(2);
	});

	it('lease claim이 실패해도 rejection을 관찰하고 다음 timer tick에서 재시도한다', async () => {
		jest.useFakeTimers();
		process.env.LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS = '100';
		process.env.LIFECYCLE_OUTBOX_CLEANUP_INTERVAL_MS = '0';
		const row = createOutboxRecord();
		const databaseError = new Error('database unavailable during claim');
		prisma.imageLifecycleOutbox.findMany.mockResolvedValue([row]);
		prisma.imageLifecycleOutbox.updateMany
			.mockRejectedValueOnce(databaseError)
			.mockResolvedValueOnce({ count: 0 });
		const loggerError = jest
			.spyOn(Logger.prototype, 'error')
			.mockImplementation(() => undefined);

		service.onModuleInit();
		await flushPromises();

		expect(loggerError).toHaveBeenCalledWith({
			event: 'image_lifecycle_outbox_background_task_failed',
			task: 'publish',
			error: databaseError.message,
			stack: databaseError.stack,
		});
		await jest.advanceTimersByTimeAsync(100);
		expect(prisma.imageLifecycleOutbox.findMany).toHaveBeenCalledTimes(2);
		expect(prisma.imageLifecycleOutbox.updateMany).toHaveBeenCalledTimes(2);
	});

	it('cleanup lock 설정이 실패해도 rejection을 관찰하고 다음 timer tick에서 재시도한다', async () => {
		jest.useFakeTimers();
		process.env.LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS = '0';
		process.env.LIFECYCLE_OUTBOX_CLEANUP_INTERVAL_MS = '100';
		const databaseError = new Error('lock timeout configuration failed');
		prisma.$executeRaw
			.mockRejectedValueOnce(databaseError)
			.mockResolvedValueOnce(1);
		prisma.$queryRaw.mockResolvedValue([]);
		const loggerError = jest
			.spyOn(Logger.prototype, 'error')
			.mockImplementation(() => undefined);

		service.onModuleInit();
		await flushPromises();

		expect(loggerError).toHaveBeenCalledWith({
			event: 'image_lifecycle_outbox_background_task_failed',
			task: 'cleanup',
			error: databaseError.message,
			stack: databaseError.stack,
		});
		await jest.advanceTimersByTimeAsync(100);
		expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
	});

	it('canonical destination row를 저장하고 lease를 획득한 뒤 발행한다', async () => {
		const row = createOutboxRecord();
		prisma.imageLifecycleOutbox.findMany.mockResolvedValue([row]);

		await service.enqueueAndPublish(event);

		expect(prisma.imageLifecycleOutbox.createMany).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					eventId: 'life-outbox-1',
					topic: canonicalTopic,
					status: 'PENDING',
				}),
			],
			skipDuplicates: true,
		});
		expect(prisma.imageLifecycleOutbox.updateMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({ id: 'outbox-1' }),
				data: expect.objectContaining({
					status: 'PUBLISHING',
					leaseOwner: expect.any(String),
					leaseExpiresAt: expect.any(Date),
				}),
			}),
		);
		expect(imageClient.emit).toHaveBeenCalledWith(canonicalTopic, {
			key: 'local-demo:products/image/sample.png:image.upload.completed',
			value: JSON.stringify(event),
		});
		expect(prisma.imageLifecycleOutbox.updateMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'outbox-1',
					leaseOwner: expect.any(String),
				}),
				data: expect.objectContaining({
					status: 'PUBLISHED',
					publishedAt: expect.any(Date),
					leaseOwner: null,
				}),
			}),
		);
	});

	it('cache invalidation row를 같은 durable outbox에서 재시도 가능하게 발행한다', async () => {
		const configuredTopic = 'custom.image.cache-invalidation.v1';
		process.env.CACHE_INVALIDATION_KAFKA_TOPIC = configuredTopic;
		const invalidation = createImageCacheInvalidationEvent({
			eventId: 'delete-event-1',
			occurredAt: '2026-07-03T00:00:00.000Z',
			clientServiceId: 'service-1',
			path: 'products',
			name: 'sample.png',
			reason: 'delete',
			assetId: 'asset-1',
		});
		prisma.imageLifecycleOutbox.findMany.mockResolvedValue([
			createOutboxRecord({
				eventId: invalidation.eventId,
				topic: configuredTopic,
				payload: invalidation as unknown as Prisma.JsonValue,
			}),
		]);

		await service.enqueueCacheInvalidationWithinTransaction(
			prisma as unknown as PrismaService,
			invalidation,
		);
		await service.publishPending();

		expect(prisma.imageLifecycleOutbox.createMany).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					eventId: 'delete-event-1',
					topic: configuredTopic,
					status: 'PENDING',
				}),
			],
			skipDuplicates: true,
		});
		expect(imageClient.emit).toHaveBeenCalledWith(configuredTopic, {
			key: 'service-1:products/sample.png',
			value: JSON.stringify(invalidation),
		});
	});

	it('active subscription이면 동일 eventId payload를 canonical/client topic별 row로 발행한다', async () => {
		prisma.clientServiceLifecycleSubscription.findFirst.mockResolvedValue({
			id: 'subscription-1',
		});
		prisma.imageLifecycleOutbox.findMany.mockResolvedValue([
			createOutboxRecord(),
			createOutboxRecord({ id: 'outbox-2', topic: clientTopic }),
		]);

		await service.enqueueAndPublish(event);

		expect(prisma.imageLifecycleOutbox.createMany).toHaveBeenCalledWith({
			data: expect.arrayContaining([
				expect.objectContaining({
					eventId: event.eventId,
					topic: canonicalTopic,
				}),
				expect.objectContaining({
					eventId: event.eventId,
					topic: clientTopic,
				}),
			]),
			skipDuplicates: true,
		});
		expect(imageClient.emit).toHaveBeenCalledTimes(2);
		expect(imageClient.emit).toHaveBeenCalledWith(canonicalTopic, {
			key: expect.any(String),
			value: JSON.stringify(event),
		});
		expect(imageClient.emit).toHaveBeenCalledWith(clientTopic, {
			key: expect.any(String),
			value: JSON.stringify(event),
		});
	});

	it('두 publisher가 같은 row를 조회해도 atomic updateMany claim 성공자만 발행한다', async () => {
		const row = createOutboxRecord();
		prisma.imageLifecycleOutbox.findMany.mockResolvedValue([row]);
		prisma.imageLifecycleOutbox.updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		const competingService = new ImageLifecycleOutboxService(
			prisma as unknown as PrismaService,
			imageClient as unknown as ClientKafka,
		);

		await service.publishPending();
		await competingService.publishPending();

		expect(imageClient.emit).toHaveBeenCalledTimes(1);
	});

	it('max attempt에 도달하면 last error와 dead-letter 시각을 보존한다', async () => {
		process.env.LIFECYCLE_OUTBOX_MAX_ATTEMPTS = '2';
		const row = createOutboxRecord({ status: 'FAILED', attempts: 1 });
		prisma.imageLifecycleOutbox.findMany.mockResolvedValue([row]);
		imageClient.emit.mockReturnValue(throwError(() => new Error('kafka down')));

		await service.publishPending();

		expect(prisma.imageLifecycleOutbox.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'outbox-1',
					leaseOwner: expect.any(String),
				}),
				data: expect.objectContaining({
					status: 'DEAD_LETTER',
					attempts: 2,
					lastError: 'kafka down',
					deadLetteredAt: expect.any(Date),
					leaseOwner: null,
				}),
			}),
		);
	});

	it('published/dead-letter 보존 기간이 지난 row를 bounded batch로 정리한다', async () => {
		process.env.LIFECYCLE_OUTBOX_CLEANUP_MAX_BATCHES_PER_RUN = '2';
		process.env.LIFECYCLE_OUTBOX_CLEANUP_BATCH_SLEEP_MS = '0';
		process.env.LIFECYCLE_OUTBOX_CLEANUP_LOCK_TIMEOUT_MS = '500';
		prisma.$queryRaw
			.mockResolvedValueOnce([{ id: 'published-1' }, { id: 'dead-letter-1' }])
			.mockResolvedValueOnce([{ id: 'published-2' }]);
		prisma.imageLifecycleOutbox.deleteMany
			.mockResolvedValueOnce({ count: 2 })
			.mockResolvedValueOnce({ count: 1 });

		await expect(service.cleanupRetainedRows(2)).resolves.toBe(3);

		expect(prisma.$transaction).toHaveBeenCalledTimes(2);
		expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
		const query = prisma.$queryRaw.mock.calls[0][0];
		expect(query.text).toContain('FROM "image_lifecycle_outbox"');
		expect(query.text).toContain('FOR UPDATE SKIP LOCKED');
		expect(query.values).toEqual(
			expect.arrayContaining(['PUBLISHED', 'DEAD_LETTER', 2]),
		);
		expect(prisma.imageLifecycleOutbox.deleteMany).toHaveBeenNthCalledWith(1, {
			where: expect.objectContaining({
				id: { in: ['published-1', 'dead-letter-1'] },
				OR: [
					{
						status: 'PUBLISHED',
						publishedAt: { lt: expect.any(Date) },
					},
					{
						status: 'DEAD_LETTER',
						deadLetteredAt: { lt: expect.any(Date) },
					},
				],
			}),
		});
	});

	it('full cleanup batch 사이에 설정된 sleep을 적용한다', async () => {
		jest.useFakeTimers();
		process.env.LIFECYCLE_OUTBOX_CLEANUP_MAX_BATCHES_PER_RUN = '2';
		process.env.LIFECYCLE_OUTBOX_CLEANUP_BATCH_SLEEP_MS = '100';
		prisma.$queryRaw
			.mockResolvedValueOnce([{ id: 'published-1' }, { id: 'published-2' }])
			.mockResolvedValueOnce([]);
		prisma.imageLifecycleOutbox.deleteMany.mockResolvedValue({ count: 2 });

		const cleanup = service.cleanupRetainedRows(2);
		await flushPromises();
		expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(99);
		expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
		await jest.advanceTimersByTimeAsync(1);
		await expect(cleanup).resolves.toBe(2);
		expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
	});

	it('pending/publishing/failed rows remain eligible for publish and are never cleanup candidates', async () => {
		process.env.LIFECYCLE_OUTBOX_CLEANUP_MAX_BATCHES_PER_RUN = '1';
		prisma.$queryRaw.mockResolvedValue([]);

		await expect(service.cleanupRetainedRows(2)).resolves.toBe(0);

		expect(prisma.imageLifecycleOutbox.deleteMany).not.toHaveBeenCalled();
		const query = prisma.$queryRaw.mock.calls[0][0];
		expect(query.values).not.toEqual(
			expect.arrayContaining(['PENDING', 'PUBLISHING', 'FAILED']),
		);
	});

	it('rechecks terminal status and cutoff during delete to preserve a destination that is still retrying', async () => {
		prisma.imageLifecycleOutbox.deleteMany.mockResolvedValue({ count: 1 });
		prisma.$queryRaw.mockResolvedValue([
			{ id: 'canonical-published' },
			{ id: 'client-failed' },
		]);

		await service.cleanupRetainedBatch({
			limit: 2,
			publishedBefore: new Date('2026-06-10T00:00:00.000Z'),
			deadLetteredBefore: new Date('2026-04-10T00:00:00.000Z'),
		});

		expect(prisma.imageLifecycleOutbox.deleteMany).toHaveBeenCalledWith({
			where: {
				id: { in: ['canonical-published', 'client-failed'] },
				OR: expect.arrayContaining([
					expect.objectContaining({ status: 'PUBLISHED' }),
					expect.objectContaining({ status: 'DEAD_LETTER' }),
				]),
			},
		});
	});
});

const flushPromises = async () => {
	for (let index = 0; index < 10; index += 1) {
		await Promise.resolve();
	}
};

const restoreEnvironmentValue = (name: string, value: string | undefined) => {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
};
