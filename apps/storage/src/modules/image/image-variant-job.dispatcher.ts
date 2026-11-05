import {
	Inject,
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit,
	Optional,
} from '@nestjs/common';
import { ImageVariantJobEvent } from '@file/telemetry-contracts/image-operations';
import { ImageLifecycleMetricsService } from './image-lifecycle-metrics.service';
import {
	IMAGE_VARIANT_JOB_REPOSITORY,
	ImageVariantJobRepository,
} from './image-variant-job.repository';
import { ImageVariantJobPublisher } from './image-variant-job.publisher';

@Injectable()
export class ImageVariantJobDispatcher
	implements OnModuleInit, OnModuleDestroy
{
	private readonly logger = new Logger(ImageVariantJobDispatcher.name);
	private timer?: NodeJS.Timeout;
	private publishing = false;

	constructor(
		@Optional()
		@Inject(IMAGE_VARIANT_JOB_REPOSITORY)
		private readonly repository: ImageVariantJobRepository | undefined,
		private readonly publisher: ImageVariantJobPublisher,
		private readonly metrics: ImageLifecycleMetricsService,
	) {}

	onModuleInit(): void {
		const intervalMs = readNonNegative(
			process.env.IMAGE_VARIANT_OUTBOX_PUBLISH_INTERVAL_MS,
			process.env.NODE_ENV === 'test' ? 0 : 1_000,
		);
		if (!this.repository || intervalMs === 0) return;
		this.runBackgroundPublish();
		this.timer = setInterval(() => this.runBackgroundPublish(), intervalMs);
		this.timer.unref?.();
	}

	onModuleDestroy(): void {
		if (this.timer) clearInterval(this.timer);
	}

	/** Ready transaction에서 이미 저장된 ledger row만 즉시 발행한다. */
	publishPersisted(jobs: ImageVariantJobEvent[]): void {
		void this.publish(jobs).catch((error: unknown) => {
			this.metrics.recordVariantPublishFailed(error);
			this.logger.error(
				`persisted variant job publish failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	async publishPersistedNow(jobs: ImageVariantJobEvent[]): Promise<number> {
		await this.publish(jobs);
		return jobs.length;
	}

	async publishPending(
		limit = readPositive(
			process.env.IMAGE_VARIANT_OUTBOX_PUBLISH_BATCH_SIZE,
			25,
		),
	): Promise<number> {
		if (!this.repository || this.publishing) return 0;
		this.publishing = true;
		try {
			const jobs = await this.repository.listPublishableJobs(limit);
			await this.publish(jobs);
			return jobs.length;
		} finally {
			this.publishing = false;
		}
	}

	private runBackgroundPublish(): void {
		void this.publishPending().catch((error: unknown) => {
			this.metrics.recordVariantPublishFailed(error);
			this.logger.error(
				`variant job background publish failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	private async publish(jobs: ImageVariantJobEvent[]): Promise<void> {
		if (!this.repository) return;
		for (const job of jobs) {
			this.metrics.recordVariantEnqueued(jobs.length);
			if (await this.publisher.publish(job)) {
				await this.repository.recordPublished(job.jobKey);
			} else {
				await this.repository.recordPublishFailure(
					job.jobKey,
					new Error('Kafka publish failed'),
				);
			}
		}
	}
}

function readPositive(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegative(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
