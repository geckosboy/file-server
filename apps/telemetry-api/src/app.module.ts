import { Module } from '@nestjs/common';
import { AdminModule } from './modules/admin/admin.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';

@Module({
	imports: [AdminModule, IngestionModule],
})
export class AppModule {}
