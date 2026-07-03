import { Module } from '@nestjs/common';
import { PrismaTelemetryRepository } from './prisma-telemetry.repository';
import { InMemoryTelemetryRepository } from './telemetry.repository';
import {
	createTelemetryRepositoryImports,
	createTelemetryRepositoryProvider,
	shouldUseInMemoryTelemetryRepository,
	TELEMETRY_REPOSITORY,
} from './telemetry-repository.provider';

const repositoryProviders = shouldUseInMemoryTelemetryRepository()
	? [InMemoryTelemetryRepository, createTelemetryRepositoryProvider()]
	: [PrismaTelemetryRepository, createTelemetryRepositoryProvider()];

@Module({
	imports: createTelemetryRepositoryImports(),
	providers: repositoryProviders,
	exports: [TELEMETRY_REPOSITORY],
})
export class TelemetryModule {}
