import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
	IMAGE_CACHE_INVALIDATION_TOPIC,
	ImageCacheInvalidationEvent,
	createImageCacheInvalidationEvent,
	createImageCacheInvalidationKafkaKey,
} from '@file/telemetry-contracts/image-operations';
import { lastValueFrom } from 'rxjs';
import { ImageLifecycleMetricsService } from './image-lifecycle-metrics.service';

export type PublishImageCacheInvalidationInput = Omit<
	ImageCacheInvalidationEvent,
	'schemaVersion' | 'eventId' | 'eventType' | 'occurredAt'
> &
	Partial<Pick<ImageCacheInvalidationEvent, 'eventId' | 'occurredAt'>>;

@Injectable()
export class ImageCacheInvalidationPublisher {
	private readonly logger = new Logger(ImageCacheInvalidationPublisher.name);

	constructor(
		@Inject('IMAGE_MICROSERVICE') private readonly imageClient: ClientKafka,
		private readonly metrics: ImageLifecycleMetricsService,
	) {}

	async publish(input: PublishImageCacheInvalidationInput): Promise<boolean> {
		this.metrics.recordInvalidationAttempt();
		const attempts = readPositive(
			process.env.CACHE_INVALIDATION_KAFKA_RETRY_MAX_ATTEMPTS,
			3,
		);
		const backoffMs = readPositive(
			process.env.CACHE_INVALIDATION_KAFKA_RETRY_BACKOFF_MS,
			100,
		);
		let lastError: unknown;
		try {
			const event = createImageCacheInvalidationEvent(input);
			const topic =
				process.env.CACHE_INVALIDATION_KAFKA_TOPIC ??
				IMAGE_CACHE_INVALIDATION_TOPIC;
			for (let attempt = 1; attempt <= attempts; attempt += 1) {
				try {
					await lastValueFrom(
						this.imageClient.emit(topic, {
							key: createImageCacheInvalidationKafkaKey(event),
							value: JSON.stringify(event),
						}),
					);
					lastError = undefined;
					break;
				} catch (error) {
					lastError = error;
					if (attempt < attempts) {
						await new Promise((resolve) => setTimeout(resolve, backoffMs));
					}
				}
			}
			if (lastError !== undefined) throw lastError;
			this.metrics.recordInvalidationPublished();
			return true;
		} catch (error) {
			this.metrics.recordInvalidationFailed(error);
			this.logger.warn(
				`cache invalidation publish failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}
}

function readPositive(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
