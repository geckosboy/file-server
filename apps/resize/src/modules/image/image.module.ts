import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Partitioners } from 'kafkajs';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';

import { ImageManager } from './manager';
import { ClientServiceAuthModule } from '@file/database';
import { envConfig } from 'src/config';

const KafkaModule = ClientsModule.register([
	{
		name: 'RESIZE_IMAGE_MICROSERVICE',
		transport: Transport.KAFKA,
		options: {
			client: {
				clientId: 'image',
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
	imports: [KafkaModule, ClientServiceAuthModule],
	controllers: [ImageController],
	providers: [ImageService, ImageManager],
})
export class ImageModule {}
