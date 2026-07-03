import { Module } from '@nestjs/common';
import { InMemoryLifecycleRepository } from './lifecycle.repository';
import { LifecycleIngestionService } from './lifecycle-ingestion.service';
import { PrismaLifecycleRepository } from './prisma-lifecycle.repository';
import {
	createLifecycleRepositoryImports,
	createLifecycleRepositoryProvider,
	LIFECYCLE_REPOSITORY,
	shouldUseInMemoryLifecycleRepository,
} from './lifecycle-repository.provider';

const repositoryProviders = shouldUseInMemoryLifecycleRepository()
	? [InMemoryLifecycleRepository, createLifecycleRepositoryProvider()]
	: [PrismaLifecycleRepository, createLifecycleRepositoryProvider()];

@Module({
	imports: createLifecycleRepositoryImports(),
	providers: [...repositoryProviders, LifecycleIngestionService],
	exports: [LIFECYCLE_REPOSITORY, LifecycleIngestionService],
})
export class LifecycleModule {}
