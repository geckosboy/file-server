import { Module } from '@nestjs/common';
import { InMemoryTelemetryRepository } from './telemetry.repository';

@Module({
	providers: [InMemoryTelemetryRepository],
	exports: [InMemoryTelemetryRepository],
})
export class TelemetryModule {}
