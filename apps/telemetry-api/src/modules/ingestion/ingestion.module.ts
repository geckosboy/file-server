import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { IngestionAuthGuard } from './ingestion-auth.guard';
import { TelemetryConfigService } from '../admin/telemetry-config.service';

@Module({
	imports: [TelemetryModule],
	controllers: [IngestionController],
	providers: [IngestionService, IngestionAuthGuard, TelemetryConfigService],
	exports: [IngestionService],
})
export class IngestionModule {}
