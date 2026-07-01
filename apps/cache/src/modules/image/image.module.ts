import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Partitioners } from 'kafkajs';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';
import { CacheModule } from '../node-cache/cache.module';
import { envConfig } from 'src/config';

const KafkaModule = ClientsModule.register([
	{
		name: 'CACHE_IMAGE_MICROSERVICE',
		transport: Transport.KAFKA,
		options: {
			client: {
				clientId: 'cache-image',
				brokers: envConfig.kafkaClientBrokerList,
			},
			producer: {
				allowAutoTopicCreation: true,
				createPartitioner: Partitioners.LegacyPartitioner,
			},
			producerOnlyMode: true,
		},
	},
]);

@Module({
	imports: [CacheModule.register(600), KafkaModule],
	controllers: [ImageController],
	providers: [ImageService],
})
export class ImageModule {}
