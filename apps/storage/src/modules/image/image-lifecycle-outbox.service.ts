import {
	Inject,
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { ImageLifecycleOutbox, Prisma } from '@prisma/client';
import { PrismaService } from '@file/database';
import {
	assertImageLifecycleEvent,
	createLifecycleKafkaKey,
} from '@file/telemetry-contracts/lifecycle';
import { createClientLifecycleTopic } from '@file/telemetry-contracts/lifecycle-topics';
import { randomUUID } from 'crypto';
import {
	IMAGE_LIFECYCLE_TOPIC,
	ImageLifecycleEvent,
	publishImageLifecycleEventOrThrow,
} from './image.lifecycle';

const OutboxStatus = {
	Pending: 'PENDING',
	Publishing: 'PUBLISHING',
	Published: 'PUBLISHED',
	Failed: 'FAILED',
	DeadLetter: 'DEAD_LETTER',
} as const;

const DEFAULT_PUBLISH_INTERVAL_MS = 5_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_CLEANUP_BATCH_SIZE = 250;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_PUBLISHED_RETENTION_DAYS = 30;
const DEFAULT_DEAD_LETTER_RETENTION_DAYS = 90;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 1_000;
type BackgroundTask = 'publish' | 'cleanup';

@Injectable()
export class ImageLifecycleOutboxService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly logger = new Logger(ImageLifecycleOutboxService.name);
	private readonly leaseOwner = `${process.pid}:${randomUUID()}`;
	private publishTimer?: NodeJS.Timeout;
	private cleanupTimer?: NodeJS.Timeout;
	private isPublishing = false;
	private isCleaningUp = false;

	constructor(
		private readonly prisma: PrismaService,
		@Inject('IMAGE_MICROSERVICE') private readonly imageClient: ClientKafka,
	) {}

	onModuleInit() {
		const publishIntervalMs = readPositiveInteger(
			process.env.LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS,
			process.env.NODE_ENV === 'test' ? 0 : DEFAULT_PUBLISH_INTERVAL_MS,
		);
		if (publishIntervalMs > 0) {
			this.runBackgroundTask('publish', this.publishPending());
			this.publishTimer = setInterval(() => {
				this.runBackgroundTask('publish', this.publishPending());
			}, publishIntervalMs);
			this.publishTimer.unref?.();
		}

		const cleanupIntervalMs = readPositiveInteger(
			process.env.LIFECYCLE_OUTBOX_CLEANUP_INTERVAL_MS,
			process.env.NODE_ENV === 'test' ? 0 : DEFAULT_CLEANUP_INTERVAL_MS,
		);
		if (cleanupIntervalMs > 0) {
			this.runBackgroundTask('cleanup', this.cleanupRetainedRows());
			this.cleanupTimer = setInterval(() => {
				this.runBackgroundTask('cleanup', this.cleanupRetainedRows());
			}, cleanupIntervalMs);
			this.cleanupTimer.unref?.();
		}
	}

	onModuleDestroy() {
		if (this.publishTimer) {
			clearInterval(this.publishTimer);
		}
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}
	}

	private runBackgroundTask(
		task: BackgroundTask,
		operation: Promise<unknown>,
	): void {
		void operation.catch((error: unknown) => {
			this.logger.error({
				event: 'image_lifecycle_outbox_background_task_failed',
				task,
				error: errorToMessage(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		});
	}

	async enqueueAndPublish(event: ImageLifecycleEvent): Promise<void> {
		const rows = await this.enqueue(event);
		for (const row of rows) {
			await this.claimAndPublish(row);
		}
	}

	async enqueue(event: ImageLifecycleEvent): Promise<ImageLifecycleOutbox[]> {
		const topics = await this.resolveDestinationTopics(event);
		await this.prisma.imageLifecycleOutbox.createMany({
			data: topics.map((topic) => ({
				eventId: event.eventId,
				topic,
				kafkaKey: createLifecycleKafkaKey(event),
				payload: event as unknown as Prisma.InputJsonValue,
				status: OutboxStatus.Pending,
				nextAttemptAt: new Date(),
			})),
			skipDuplicates: true,
		});

		return this.prisma.imageLifecycleOutbox.findMany({
			where: { eventId: event.eventId, topic: { in: topics } },
			orderBy: { topic: 'asc' },
		});
	}

	async publishPending(limit = readBatchSize()): Promise<void> {
		if (this.isPublishing) {
			return;
		}

		this.isPublishing = true;
		try {
			const now = new Date();
			const rows = await this.prisma.imageLifecycleOutbox.findMany({
				where: {
					status: {
						in: [
							OutboxStatus.Pending,
							OutboxStatus.Failed,
							OutboxStatus.Publishing,
						],
					},
					nextAttemptAt: { lte: now },
					OR: [
						{ leaseOwner: null },
						{ leaseExpiresAt: null },
						{ leaseExpiresAt: { lte: now } },
					],
				},
				orderBy: { createdAt: 'asc' },
				take: limit,
			});

			for (const row of rows) {
				await this.claimAndPublish(row, now);
			}
		} finally {
			this.isPublishing = false;
		}
	}

	async cleanupRetainedRows(
		limit = readPositiveInteger(
			process.env.LIFECYCLE_OUTBOX_CLEANUP_BATCH_SIZE,
			DEFAULT_CLEANUP_BATCH_SIZE,
		),
	): Promise<number> {
		if (this.isCleaningUp) {
			return 0;
		}

		this.isCleaningUp = true;
		try {
			const now = Date.now();
			const publishedBefore = new Date(
				now -
					readRetentionDays(
						process.env.LIFECYCLE_OUTBOX_PUBLISHED_RETENTION_DAYS,
						DEFAULT_PUBLISHED_RETENTION_DAYS,
					) *
						24 *
						60 *
						60 *
						1000,
			);
			const deadLetteredBefore = new Date(
				now -
					readRetentionDays(
						process.env.LIFECYCLE_OUTBOX_DEAD_LETTER_RETENTION_DAYS,
						DEFAULT_DEAD_LETTER_RETENTION_DAYS,
					) *
						24 *
						60 *
						60 *
						1000,
			);
			const expiredRows = await this.prisma.imageLifecycleOutbox.findMany({
				where: {
					OR: [
						{
							status: OutboxStatus.Published,
							publishedAt: { lte: publishedBefore },
						},
						{
							status: OutboxStatus.DeadLetter,
							deadLetteredAt: { lte: deadLetteredBefore },
						},
					],
				},
				select: { id: true },
				orderBy: { createdAt: 'asc' },
				take: limit,
			});
			if (expiredRows.length === 0) {
				return 0;
			}

			const result = await this.prisma.imageLifecycleOutbox.deleteMany({
				where: { id: { in: expiredRows.map(({ id }) => id) } },
			});
			return result.count;
		} finally {
			this.isCleaningUp = false;
		}
	}

	private async resolveDestinationTopics(
		event: ImageLifecycleEvent,
	): Promise<string[]> {
		const topics = [IMAGE_LIFECYCLE_TOPIC as string];
		if (!event.clientServiceId) {
			return topics;
		}

		const activeSubscription =
			await this.prisma.clientServiceLifecycleSubscription.findFirst({
				where: {
					clientServiceId: event.clientServiceId,
					eventType: event.eventType,
					isEnabled: true,
				},
				select: { id: true },
			});
		if (activeSubscription) {
			topics.push(createClientLifecycleTopic(event.clientServiceId));
		}
		return topics;
	}

	private async claimAndPublish(
		row: ImageLifecycleOutbox,
		now = new Date(),
	): Promise<void> {
		if (
			row.status === OutboxStatus.Published ||
			row.status === OutboxStatus.DeadLetter
		) {
			return;
		}

		const leaseExpiresAt = new Date(now.getTime() + readLeaseDurationMs());
		const claim = await this.prisma.imageLifecycleOutbox.updateMany({
			where: {
				id: row.id,
				status: {
					in: [
						OutboxStatus.Pending,
						OutboxStatus.Failed,
						OutboxStatus.Publishing,
					],
				},
				nextAttemptAt: { lte: now },
				OR: [
					{ leaseOwner: null },
					{ leaseExpiresAt: null },
					{ leaseExpiresAt: { lte: now } },
				],
			},
			data: {
				status: OutboxStatus.Publishing,
				leaseOwner: this.leaseOwner,
				leaseExpiresAt,
			},
		});
		if (claim.count !== 1) {
			return;
		}

		await this.tryPublish(row);
	}

	private async tryPublish(row: ImageLifecycleOutbox): Promise<void> {
		try {
			const event = assertImageLifecycleEvent(row.payload);
			await publishImageLifecycleEventOrThrow({
				client: this.imageClient,
				event,
				topic: row.topic,
			});
			await this.prisma.imageLifecycleOutbox.updateMany({
				where: { id: row.id, leaseOwner: this.leaseOwner },
				data: {
					status: OutboxStatus.Published,
					publishedAt: new Date(),
					deadLetteredAt: null,
					lastError: null,
					leaseOwner: null,
					leaseExpiresAt: null,
				},
			});
		} catch (error) {
			const attempts = row.attempts + 1;
			const lastError = truncateError(errorToMessage(error));
			const isDeadLetter = attempts >= readMaxAttempts();
			await this.prisma.imageLifecycleOutbox.updateMany({
				where: { id: row.id, leaseOwner: this.leaseOwner },
				data: {
					status: isDeadLetter ? OutboxStatus.DeadLetter : OutboxStatus.Failed,
					attempts,
					lastError,
					nextAttemptAt: new Date(Date.now() + getRetryDelayMs(attempts)),
					deadLetteredAt: isDeadLetter ? new Date() : null,
					leaseOwner: null,
					leaseExpiresAt: null,
				},
			});
			const message = `이미지 lifecycle outbox 발행 실패(eventId=${row.eventId}, topic=${row.topic}, attempts=${attempts}): ${lastError}`;
			if (isDeadLetter) {
				this.logger.error(`DEAD_LETTER ${message}`);
			} else {
				this.logger.warn(message);
			}
		}
	}
}

function readBatchSize(): number {
	return readPositiveInteger(
		process.env.LIFECYCLE_OUTBOX_PUBLISH_BATCH_SIZE,
		DEFAULT_BATCH_SIZE,
	);
}

function readLeaseDurationMs(): number {
	return readPositiveInteger(
		process.env.LIFECYCLE_OUTBOX_LEASE_DURATION_MS,
		DEFAULT_LEASE_DURATION_MS,
	);
}

function readMaxAttempts(): number {
	return Math.max(
		1,
		readPositiveInteger(
			process.env.LIFECYCLE_OUTBOX_MAX_ATTEMPTS,
			DEFAULT_MAX_ATTEMPTS,
		),
	);
}

function readRetentionDays(
	value: string | undefined,
	fallback: number,
): number {
	return Math.max(1, readPositiveInteger(value, fallback));
}

function readPositiveInteger(value: string | undefined, fallback: number) {
	if (value === undefined) {
		return fallback;
	}

	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getRetryDelayMs(attempts: number): number {
	const exponent = Math.min(Math.max(attempts - 1, 0), 6);
	return Math.min(60_000 * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

function truncateError(message: string): string {
	return message.length > MAX_ERROR_LENGTH
		? `${message.slice(0, MAX_ERROR_LENGTH)}...`
		: message;
}

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
