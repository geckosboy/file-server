import { Module } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { TelemetryConfigService } from '../admin/telemetry-config.service';
import { ClientServicesController } from './client-services.controller';
import {
	createClientServicesRepositoryImports,
	createClientServicesRepositoryProvider,
	CLIENT_SERVICES_REPOSITORY,
	shouldUseInMemoryClientServicesRepository,
} from './client-services-repository.provider';
import { InMemoryClientServicesRepository } from './client-services.repository';
import { ClientServicesService } from './client-services.service';
import { PrismaClientServicesRepository } from './prisma-client-services.repository';
import { KafkaLifecycleProvisionerService } from './kafka-lifecycle-provisioner.service';

const repositoryProviders = shouldUseInMemoryClientServicesRepository()
	? [InMemoryClientServicesRepository, createClientServicesRepositoryProvider()]
	: [PrismaClientServicesRepository, createClientServicesRepositoryProvider()];

@Module({
	imports: createClientServicesRepositoryImports(),
	controllers: [ClientServicesController],
	providers: [
		AdminAuthGuard,
		TelemetryConfigService,
		ClientServicesService,
		KafkaLifecycleProvisionerService,
		...repositoryProviders,
	],
	exports: [ClientServicesService, CLIENT_SERVICES_REPOSITORY],
})
export class ClientServicesModule {}
