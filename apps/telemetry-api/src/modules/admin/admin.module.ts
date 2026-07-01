import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminController } from './admin.controller';
import { AdminQueryService } from './admin-query.service';
import { TelemetryConfigService } from './telemetry-config.service';

@Module({
	imports: [TelemetryModule],
	controllers: [AdminController],
	providers: [AdminAuthGuard, AdminQueryService, TelemetryConfigService],
	exports: [AdminQueryService],
})
export class AdminModule {}
