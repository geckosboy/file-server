import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
	IMAGE_VARIANT_JOB_TOPIC,
	ImageVariantJobEvent,
	assertImageVariantJobEvent,
	createImageVariantJobKafkaKey,
} from '@file/telemetry-contracts/image-operations';
import { lastValueFrom } from 'rxjs';
import { ImageLifecycleMetricsService } from './image-lifecycle-metrics.service';

@Injectable()
export class ImageVariantJobPublisher {
	private readonly logger = new Logger(ImageVariantJobPublisher.name);

	constructor(
		@Inject('IMAGE_MICROSERVICE') private readonly imageClient: ClientKafka,
		private readonly metrics: ImageLifecycleMetricsService,
	) {}

	async publish(event: ImageVariantJobEvent): Promise<boolean> {
		try {
			const validated = assertImageVariantJobEvent(event);
			await lastValueFrom(
				this.imageClient.emit(
					process.env.IMAGE_VARIANT_KAFKA_TOPIC ?? IMAGE_VARIANT_JOB_TOPIC,
					{
						key: createImageVariantJobKafkaKey(validated),
						value: JSON.stringify(validated),
					},
				),
			);
			this.metrics.recordVariantPublished();
			return true;
		} catch (error) {
			this.metrics.recordVariantPublishFailed(error);
			this.logger.warn(
				`variant job publish failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}
}
