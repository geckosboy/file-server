import { Module } from '@nestjs/common';
import { LoggerModule } from '@file/nest-common';
import { AppController } from './app.controller';
import { ImageModule } from './modules/image/image.module';
import { ConfigModule } from './config';
import { AppHealthService } from './app-health.service';
import { PrismaModule } from '@file/database';

@Module({
	imports: [
		LoggerModule.forRoot({
			appName: 'resize',
			exclude: ['/health-check', '/health/live', '/health/ready'],
		}),
		ConfigModule,
		PrismaModule,
		ImageModule,
	],
	controllers: [AppController],
	providers: [AppHealthService],
})
export class AppModule {}
