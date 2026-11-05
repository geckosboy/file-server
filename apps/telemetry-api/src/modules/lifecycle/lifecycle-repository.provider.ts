import { Provider } from '@nestjs/common';
import { PrismaModule } from '@file/database';
import {
	InMemoryLifecycleRepository,
	LifecycleRepository,
} from './lifecycle.repository';
import { PrismaLifecycleRepository } from './prisma-lifecycle.repository';
import { shouldUseInMemoryTelemetryRepository } from '../telemetry/telemetry-repository.provider';

export const LIFECYCLE_REPOSITORY = Symbol('LIFECYCLE_REPOSITORY');

export const shouldUseInMemoryLifecycleRepository =
	shouldUseInMemoryTelemetryRepository;

export const createLifecycleRepositoryImports = () =>
	shouldUseInMemoryLifecycleRepository() ? [] : [PrismaModule];

export const createLifecycleRepositoryProvider =
	(): Provider<LifecycleRepository> =>
		shouldUseInMemoryLifecycleRepository()
			? {
					provide: LIFECYCLE_REPOSITORY,
					useClass: InMemoryLifecycleRepository,
				}
			: {
					provide: LIFECYCLE_REPOSITORY,
					useClass: PrismaLifecycleRepository,
				};
