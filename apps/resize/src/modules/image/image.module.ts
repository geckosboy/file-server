import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Partitioners } from 'kafkajs';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';

import { ImageManager } from './manager';
import { ClientServiceAuthModule } from '@file/database';
import { readKafkaClientSecurityOptions } from '@file/nest-common';
import { envConfig } from 'src/config';
import {
	IMAGE_TELEMETRY_KAFKA_RETRY_OPTIONS,
	IMAGE_TELEMETRY_KAFKA_SEND_OPTIONS,
} from '@file/telemetry-contracts/events';

const KafkaModule = ClientsModule.register([
	{
		name: 'RESIZE_IMAGE_MICROSERVICE',
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
	imports: [KafkaModule, ClientServiceAuthModule],
	controllers: [ImageController],
	providers: [ImageService, ImageManager],
})
export class ImageModule {}
