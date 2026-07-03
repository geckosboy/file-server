import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Partitioners } from 'kafkajs';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';
import { JpegStrategy } from './strategies/sharp/jpeg.strategy';
import { PngStrategy } from './strategies/sharp/png.strategy';
import { ImageManager } from './strategies/manager';
import { ClientServiceAuthModule, PrismaModule } from '@file/database';
import { envConfig } from 'src/config';
import { ImageLifecycleOutboxService } from './image-lifecycle-outbox.service';
import { ImagePregenerationService } from './image-pregeneration.service';

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
	imports: [KafkaModule, ClientServiceAuthModule, PrismaModule],
	controllers: [ImageController],
	providers: [
		ImageService,
		ImageLifecycleOutboxService,
		ImagePregenerationService,
		...strategyList,
	],
})
export class ImageModule {}
