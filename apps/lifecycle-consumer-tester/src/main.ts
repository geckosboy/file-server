import './config/runtime-env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { readHttpConfig } from './config/lifecycle-consumer-tester.config';

async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	const logger = new Logger('LifecycleConsumerTester');
	const { host, port } = readHttpConfig();

	app.enableCors({ origin: true, credentials: true });
	await app.listen(port, host, () => {
		logger.log(`Nest on: ${host}:${port}`);
		if (process.send) {
			process.send('ready');
		}
	});
}

void bootstrap();
