import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';

@Module({
	imports: [TelemetryModule],
	controllers: [IngestionController],
	providers: [IngestionService],
	exports: [IngestionService],
})
export class IngestionModule {}
