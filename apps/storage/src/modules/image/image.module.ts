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
import { PolicyAwareImageUploadInterceptor } from './policy-aware-image-upload.interceptor';
import {
	IMAGE_TELEMETRY_KAFKA_RETRY_OPTIONS,
	IMAGE_TELEMETRY_KAFKA_SEND_OPTIONS,
} from '@file/telemetry-contracts/events';

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
		PolicyAwareImageUploadInterceptor,
		...strategyList,
	],
})
export class ImageModule {}
