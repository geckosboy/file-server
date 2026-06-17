import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Partitioners } from 'kafkajs';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';
import { JpegStrategy } from './strategies/sharp/jpeg.strategy';
import { PngStrategy } from './strategies/sharp/png.strategy';
import { ImageManager } from './strategies/manager';
import { InternalApiKeyGuard } from './internal-api-key.guard';
import { envConfig } from 'src/config';

const strategyList = [JpegStrategy, PngStrategy, ImageManager];
const KafkaModule = ClientsModule.register([
	{
		name: 'IMAGE_MICROSERVICE',
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
	imports: [KafkaModule],
	controllers: [ImageController],
	providers: [ImageService, InternalApiKeyGuard, ...strategyList],
})
export class ImageModule {}
