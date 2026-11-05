import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import { AppConfig } from './config';
import { readKafkaClientSecurityOptions } from '@file/nest-common';
import {
	IMAGE_TELEMETRY_KAFKA_RETRY_OPTIONS,
	IMAGE_TELEMETRY_KAFKA_SEND_OPTIONS,
} from '@file/telemetry-contracts/events';

async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	const logger = new Logger();
	const {
		PORT,
		isDevelopment,
		isProduction,
		originList,
		HOST,
		kafkaClientBrokerList,
	} = app.get(AppConfig);

	app.enableCors({ origin: originList, credentials: true });
	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			transform: true,
			transformOptions: { enableImplicitConversion: true },
			enableDebugMessages: isDevelopment,
			disableErrorMessages: isProduction,
		}),
	);
	app.connectMicroservice({
		transport: Transport.KAFKA,
		options: {
			client: {
				clientId: 'image',
				brokers: kafkaClientBrokerList,
				...readKafkaClientSecurityOptions(),
				retry: { ...IMAGE_TELEMETRY_KAFKA_RETRY_OPTIONS },
			},
			producer: {
				allowAutoTopicCreation: false,
			},
			send: { ...IMAGE_TELEMETRY_KAFKA_SEND_OPTIONS },
			producerOnlyMode: true,
		},
	});

	await app.listen(PORT, HOST ?? '127.0.0.1', () => {
		logger.log(`Nest on: ${HOST ?? '127.0.0.1'}:${PORT}`);
	});
}
bootstrap();
