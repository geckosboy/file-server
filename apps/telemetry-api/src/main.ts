import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	const logger = new Logger('TelemetryApi');
	const host = process.env.HOST ?? '127.0.0.1';
	const port = Number(process.env.PORT ?? 3100);

	app.enableCors({ origin: true, credentials: true });
	await app.listen(port, host, () => {
		logger.log(`Nest on: ${host}:${port}`);
		if (process.send) {
			process.send('ready');
		}
	});
}

void bootstrap();
