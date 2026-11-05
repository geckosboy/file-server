import './config/runtime-env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TelemetryConfigService } from './modules/admin/telemetry-config.service';

async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	const logger = new Logger('TelemetryApi');
	const host = process.env.HOST ?? '127.0.0.1';
	const port = Number(process.env.PORT ?? 3100);
	const config = app.get(TelemetryConfigService);

	app.enableCors({
		origin: config.corsOrigins,
		credentials: config.corsOrigins.length > 0,
	});
	await app.listen(port, host, () => {
		logger.log(`Nest on: ${host}:${port}`);
		if (process.send) {
			process.send('ready');
		}
	});
}

void bootstrap();
