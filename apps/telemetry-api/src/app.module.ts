import { Module } from '@nestjs/common';
import { AdminModule } from './modules/admin/admin.module';
import { ClientServicesModule } from './modules/client-services/client-services.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';

@Module({
	imports: [AdminModule, IngestionModule, ClientServicesModule],
})
export class AppModule {}
