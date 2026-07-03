import { Module } from '@nestjs/common';
import { AdminModule } from './modules/admin/admin.module';
import { ClientServicesModule } from './modules/client-services/client-services.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { KafkaIngestionModule } from './modules/kafka-ingestion/kafka-ingestion.module';
import { KafkaLifecycleModule } from './modules/kafka-lifecycle/kafka-lifecycle.module';

@Module({
	imports: [
		AdminModule,
		IngestionModule,
		ClientServicesModule,
		KafkaIngestionModule,
		KafkaLifecycleModule,
	],
})
export class AppModule {}
