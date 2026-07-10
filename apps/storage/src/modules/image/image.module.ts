import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Partitioners } from 'kafkajs';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';
import { JpegStrategy } from './strategies/sharp/jpeg.strategy';
import { PngStrategy } from './strategies/sharp/png.strategy';
import { ImageManager } from './strategies/manager';
import { ClientServiceAuthModule, PrismaModule } from '@file/database';
import { readKafkaClientSecurityOptions } from '@file/nest-common';
import { envConfig } from 'src/config';
import { ImageLifecycleOutboxService } from './image-lifecycle-outbox.service';
import { ImagePregenerationService } from './image-pregeneration.service';
import { ImageCacheInvalidationPublisher } from './image-cache-invalidation.publisher';
import { ImageLifecycleMetricsService } from './image-lifecycle-metrics.service';
import {
	IMAGE_RECONCILIATION_METRICS_SOURCE,
	IMAGE_LIFECYCLE_HEALTH_METRICS,
	ImageLifecycleHealthService,
} from './image-lifecycle-health.service';
import { ImageVariantJobDispatcher } from './image-variant-job.dispatcher';
import { ImageVariantJobPublisher } from './image-variant-job.publisher';
import { ImageVariantJobWorker } from './image-variant-job.worker';
import { IMAGE_VARIANT_JOB_REPOSITORY } from './image-variant-job.repository';
import { PolicyAwareImageUploadInterceptor } from './policy-aware-image-upload.interceptor';
import {
	IMAGE_TELEMETRY_KAFKA_RETRY_OPTIONS,
	IMAGE_TELEMETRY_KAFKA_SEND_OPTIONS,
} from '@file/telemetry-contracts/events';
import { ImageFilesystemStore } from './image-filesystem.store';
import {
	IMAGE_ASSET_LIFECYCLE_METADATA,
	IMAGE_CACHE_INVALIDATION_PORT,
	ImageAssetLifecycleService,
} from './image-asset-lifecycle.service';
import { ImageReconciliationScheduler } from './image-reconciliation.scheduler';
import {
	ImageAssetLifecycleMetadataAdapter,
	ImageCacheInvalidationAdapter,
	ImageVariantJobRepositoryAdapter,
} from './image-lifecycle.adapters';
import { ImageLifecycleFailpointService } from './image-lifecycle.failpoints';

const strategyList = [JpegStrategy, PngStrategy, ImageManager];
const KafkaModule = ClientsModule.register([
	{
		name: 'IMAGE_MICROSERVICE',
		transport: Transport.KAFKA,
		options: {
			client: {
				clientId: 'image',
				brokers: envConfig.kafkaClientBrokerList,
				...readKafkaClientSecurityOptions(),
				retry: { ...IMAGE_TELEMETRY_KAFKA_RETRY_OPTIONS },
			},
			producer: {
				allowAutoTopicCreation: false,
				createPartitioner: Partitioners.LegacyPartitioner,
			},
			send: { ...IMAGE_TELEMETRY_KAFKA_SEND_OPTIONS },
			producerOnlyMode: true,
		},
	},
]);

@Module({
	imports: [KafkaModule, ClientServiceAuthModule, PrismaModule],
	controllers: [ImageController],
	providers: [
		ImageService,
		ImageLifecycleOutboxService,
		ImagePregenerationService,
		ImageLifecycleMetricsService,
		ImageLifecycleHealthService,
		ImageCacheInvalidationPublisher,
		ImageVariantJobPublisher,
		ImageVariantJobDispatcher,
		ImageVariantJobWorker,
		ImageFilesystemStore,
		ImageLifecycleFailpointService,
		ImageAssetLifecycleService,
		ImageReconciliationScheduler,
		ImageAssetLifecycleMetadataAdapter,
		ImageCacheInvalidationAdapter,
		ImageVariantJobRepositoryAdapter,
		{
			provide: IMAGE_ASSET_LIFECYCLE_METADATA,
			useExisting: ImageAssetLifecycleMetadataAdapter,
		},
		{
			provide: IMAGE_CACHE_INVALIDATION_PORT,
			useExisting: ImageCacheInvalidationAdapter,
		},
		{
			provide: IMAGE_VARIANT_JOB_REPOSITORY,
			useExisting: ImageVariantJobRepositoryAdapter,
		},
		{
			provide: IMAGE_RECONCILIATION_METRICS_SOURCE,
			useExisting: ImageAssetLifecycleMetadataAdapter,
		},
		{
			provide: IMAGE_LIFECYCLE_HEALTH_METRICS,
			useExisting: ImageLifecycleHealthService,
		},
		PolicyAwareImageUploadInterceptor,
		...strategyList,
	],
	exports: [
		IMAGE_LIFECYCLE_HEALTH_METRICS,
		ImageCacheInvalidationPublisher,
		ImageVariantJobDispatcher,
		ImageAssetLifecycleService,
	],
})
export class ImageModule {}
