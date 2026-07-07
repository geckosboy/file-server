import { ClientKafka } from '@nestjs/microservices';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@file/database';
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

const createOutboxRecord = (overrides: Record<string, unknown> = {}) => ({
	id: 'outbox-1',
	eventId: event.eventId,
	topic: 'file.image.lifecycle.v1',
	kafkaKey: 'local-demo:products/image/sample.png:image.upload.completed',
	payload: event as unknown as Prisma.JsonValue,
	status: 'PENDING',
	attempts: 0,
	nextAttemptAt: new Date('2026-07-03T00:00:00.000Z'),
	publishedAt: null,
	lastError: null,
	createdAt: new Date('2026-07-03T00:00:00.000Z'),
	updatedAt: new Date('2026-07-03T00:00:00.000Z'),
	...overrides,
});

type PrismaMock = {
	imageLifecycleOutbox: {
		create: jest.Mock;
		findUnique: jest.Mock;
		findMany: jest.Mock;
		update: jest.Mock;
	};
};

const createPrismaMock = (): PrismaMock => ({
	imageLifecycleOutbox: {
		create: jest.fn(),
		findUnique: jest.fn(),
		findMany: jest.fn(),
		update: jest.fn(),
	},
});

describe('이미지 lifecycle outbox 서비스', () => {
	const originalNodeEnv = process.env.NODE_ENV;
	let prisma: PrismaMock;
	let imageClient: jest.Mocked<Pick<ClientKafka, 'emit'>>;
	let service: ImageLifecycleOutboxService;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
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
		process.env.NODE_ENV = originalNodeEnv;
		jest.restoreAllMocks();
	});

	it('이벤트를 outbox에 저장한 뒤 Kafka 발행 성공 시 published로 표시한다', async () => {
		const row = createOutboxRecord();
		prisma.imageLifecycleOutbox.create.mockResolvedValue(row);
		prisma.imageLifecycleOutbox.update.mockResolvedValue({
			...row,
			status: 'PUBLISHED',
		});

		await service.enqueueAndPublish(event);

		expect(prisma.imageLifecycleOutbox.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventId: 'life-outbox-1',
				topic: 'file.image.lifecycle.v1',
				kafkaKey: 'local-demo:products/image/sample.png:image.upload.completed',
				status: 'PENDING',
			}),
		});
		expect(imageClient.emit).toHaveBeenCalledWith('file.image.lifecycle.v1', {
			key: 'local-demo:products/image/sample.png:image.upload.completed',
			value: JSON.stringify(event),
		});
		expect(prisma.imageLifecycleOutbox.update).toHaveBeenCalledWith({
			where: { id: 'outbox-1' },
			data: expect.objectContaining({
				status: 'PUBLISHED',
				publishedAt: expect.any(Date),
				lastError: null,
			}),
		});
	});

	it('Kafka 발행 실패 시 업로드 흐름으로 예외를 전파하지 않고 재시도 상태로 남긴다', async () => {
		const row = createOutboxRecord();
		prisma.imageLifecycleOutbox.create.mockResolvedValue(row);
		prisma.imageLifecycleOutbox.update.mockResolvedValue({
			...row,
			status: 'FAILED',
			attempts: 1,
		});
		imageClient.emit.mockReturnValue(throwError(() => new Error('kafka down')));

		await expect(service.enqueueAndPublish(event)).resolves.toBeUndefined();

		expect(prisma.imageLifecycleOutbox.update).toHaveBeenCalledWith({
			where: { id: 'outbox-1' },
			data: expect.objectContaining({
				status: 'FAILED',
				attempts: 1,
				lastError: 'kafka down',
				nextAttemptAt: expect.any(Date),
			}),
		});
	});

	it('실패 또는 대기 중인 outbox row를 scheduled publisher가 다시 발행한다', async () => {
		const row = createOutboxRecord({ status: 'FAILED', attempts: 1 });
		prisma.imageLifecycleOutbox.findMany.mockResolvedValue([row]);
		prisma.imageLifecycleOutbox.update.mockResolvedValue({
			...row,
			status: 'PUBLISHED',
		});

		await service.publishPending();

		expect(prisma.imageLifecycleOutbox.findMany).toHaveBeenCalledWith({
			where: {
				status: { in: ['PENDING', 'FAILED'] },
				nextAttemptAt: { lte: expect.any(Date) },
			},
			orderBy: { createdAt: 'asc' },
			take: 25,
		});
		expect(imageClient.emit).toHaveBeenCalledWith('file.image.lifecycle.v1', {
			key: 'local-demo:products/image/sample.png:image.upload.completed',
			value: JSON.stringify(event),
		});
	});
});
