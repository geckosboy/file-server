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
import {
	IMAGE_LIFECYCLE_TOPIC,
	ImageLifecycleEvent,
	publishImageLifecycleEventOrThrow,
} from './image.lifecycle';

const OutboxStatus = {
	Pending: 'PENDING',
	Published: 'PUBLISHED',
	Failed: 'FAILED',
} as const;

const DEFAULT_PUBLISH_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 25;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 1_000;

@Injectable()
export class ImageLifecycleOutboxService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly logger = new Logger(ImageLifecycleOutboxService.name);
	private publishTimer?: NodeJS.Timeout;
	private isPublishing = false;

	constructor(
		private readonly prisma: PrismaService,
		@Inject('IMAGE_MICROSERVICE') private readonly imageClient: ClientKafka,
	) {}

	onModuleInit() {
		const intervalMs = readPositiveInteger(
			process.env.LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS,
			process.env.NODE_ENV === 'test' ? 0 : DEFAULT_PUBLISH_INTERVAL_MS,
		);
		if (intervalMs <= 0) {
			return;
		}

		void this.publishPending();
		this.publishTimer = setInterval(() => {
			void this.publishPending();
		}, intervalMs);
		this.publishTimer.unref?.();
	}

	onModuleDestroy() {
		if (this.publishTimer) {
			clearInterval(this.publishTimer);
		}
	}

	async enqueueAndPublish(event: ImageLifecycleEvent): Promise<void> {
		const outbox = await this.enqueue(event);
		await this.tryPublish(outbox);
	}

	async enqueue(event: ImageLifecycleEvent): Promise<ImageLifecycleOutbox> {
		try {
			return await this.prisma.imageLifecycleOutbox.create({
				data: {
					eventId: event.eventId,
					topic: IMAGE_LIFECYCLE_TOPIC,
					kafkaKey: createLifecycleKafkaKey(event),
					payload: event as unknown as Prisma.InputJsonValue,
					status: OutboxStatus.Pending,
					nextAttemptAt: new Date(),
				},
			});
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				const existing = await this.prisma.imageLifecycleOutbox.findUnique({
					where: { eventId: event.eventId },
				});
				if (existing) {
					return existing;
				}
			}
			throw error;
		}
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
					status: { in: [OutboxStatus.Pending, OutboxStatus.Failed] },
					nextAttemptAt: { lte: now },
				},
				orderBy: { createdAt: 'asc' },
				take: limit,
			});

			for (const row of rows) {
				await this.tryPublish(row);
			}
		} finally {
			this.isPublishing = false;
		}
	}

	private async tryPublish(row: ImageLifecycleOutbox): Promise<void> {
		if (row.status === OutboxStatus.Published) {
			return;
		}

		try {
			const event = assertImageLifecycleEvent(row.payload);
			await publishImageLifecycleEventOrThrow({
				client: this.imageClient,
				event,
			});
			await this.prisma.imageLifecycleOutbox.update({
				where: { id: row.id },
				data: {
					status: OutboxStatus.Published,
					publishedAt: new Date(),
					lastError: null,
				},
			});
		} catch (error) {
			const attempts = row.attempts + 1;
			const lastError = truncateError(errorToMessage(error));
			await this.prisma.imageLifecycleOutbox.update({
				where: { id: row.id },
				data: {
					status: OutboxStatus.Failed,
					attempts,
					lastError,
					nextAttemptAt: new Date(Date.now() + getRetryDelayMs(attempts)),
				},
			});
			this.logger.warn(
				`이미지 lifecycle outbox 발행 실패(eventId=${row.eventId}, attempts=${attempts}): ${lastError}`,
			);
		}
	}
}

function readBatchSize(): number {
	return readPositiveInteger(
		process.env.LIFECYCLE_OUTBOX_PUBLISH_BATCH_SIZE,
		DEFAULT_BATCH_SIZE,
	);
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

function isUniqueConstraintError(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === 'P2002'
	);
}
