import { Module } from '@nestjs/common';
import { LoggerModule } from '@file/nest-common';
import { AppController } from './app.controller';
import { ImageModule } from './modules/image/image.module';
import { ConfigModule } from './config';

@Module({
	imports: [
		LoggerModule.forRoot({ appName: 'resize', exclude: ['/health-check'] }),
		ConfigModule,
		ImageModule,
	],
	controllers: [AppController],
	providers: [],
})
export class AppModule {}
