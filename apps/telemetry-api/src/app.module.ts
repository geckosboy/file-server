import { Module } from '@nestjs/common';
import { LoggerModule } from '@file/nest-common';
import { AdminModule } from './modules/admin/admin.module';
import { ClientServicesModule } from './modules/client-services/client-services.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { KafkaIngestionModule } from './modules/kafka-ingestion/kafka-ingestion.module';
import { KafkaLifecycleModule } from './modules/kafka-lifecycle/kafka-lifecycle.module';
import { createRetentionModuleImports } from './modules/retention/retention.module';

@Module({
	imports: [
		LoggerModule.forRoot({
			appName: 'telemetry-api',
			exclude: ['/api/admin/health'],
		}),
		AdminModule,
		IngestionModule,
		ClientServicesModule,
		KafkaIngestionModule,
		KafkaLifecycleModule,
		...createRetentionModuleImports(),
	],
})
export class AppModule {}
