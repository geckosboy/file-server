import { Module } from '@nestjs/common';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { AdminAuthGuard } from './admin-auth.guard';
import {
	createAdminAnalyticsImports,
	createAdminAnalyticsProviders,
} from './admin-analytics.provider';
import { AdminController } from './admin.controller';
import { AdminQueryService } from './admin-query.service';
import { TelemetryConfigService } from './telemetry-config.service';

@Module({
	imports: [TelemetryModule, LifecycleModule, ...createAdminAnalyticsImports()],
	controllers: [AdminController],
	providers: [
		AdminAuthGuard,
		AdminQueryService,
		TelemetryConfigService,
		...createAdminAnalyticsProviders(),
	],
	exports: [AdminQueryService],
})
export class AdminModule {}
