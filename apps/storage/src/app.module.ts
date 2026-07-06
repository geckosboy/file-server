import { Module } from '@nestjs/common';
import { LoggerModule } from '@file/nest-common';
import { AppController } from './app.controller';
import { ConfigModule } from './config';
import { ImageModule } from './modules/image/image.module';

@Module({
	imports: [
		LoggerModule.forRoot({ appName: 'storage', exclude: ['/health-check'] }),
		ConfigModule,
		ImageModule,
	],
	controllers: [AppController],
	providers: [],
})
export class AppModule {}
