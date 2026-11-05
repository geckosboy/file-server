import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Partitioners } from 'kafkajs';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';
import { ClientServiceAuthModule } from '@file/database';
import { readKafkaClientSecurityOptions } from '@file/nest-common';
import { CacheModule } from '../node-cache/cache.module';
import { CacheService } from '../node-cache/cache.service';
import { envConfig } from 'src/config';
import {
	IMAGE_TELEMETRY_KAFKA_RETRY_OPTIONS,
	IMAGE_TELEMETRY_KAFKA_SEND_OPTIONS,
} from '@file/telemetry-contracts/events';
import {
	CACHE_HEALTH_METRICS,
	CACHE_INVALIDATION_HEALTH_METRICS,
	CACHE_SINGLEFLIGHT_HEALTH_METRICS,
} from '../../app-health.metrics';
import { CacheInvalidationConsumerService } from './cache-invalidation-consumer.service';

const KafkaModule = ClientsModule.register([
	{
		name: 'CACHE_IMAGE_MICROSERVICE',
		transport: Transport.KAFKA,
		options: {
			client: {
				clientId: 'cache-image',
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
	imports: [CacheModule.register(600), KafkaModule, ClientServiceAuthModule],
	controllers: [ImageController],
	providers: [
		ImageService,
		CacheInvalidationConsumerService,
		{ provide: CACHE_HEALTH_METRICS, useExisting: CacheService },
		{
			provide: CACHE_SINGLEFLIGHT_HEALTH_METRICS,
			useExisting: ImageService,
		},
		{
			provide: CACHE_INVALIDATION_HEALTH_METRICS,
			useExisting: CacheInvalidationConsumerService,
		},
	],
	exports: [
		CACHE_HEALTH_METRICS,
		CACHE_SINGLEFLIGHT_HEALTH_METRICS,
		CACHE_INVALIDATION_HEALTH_METRICS,
	],
})
export class ImageModule {}
