import { Provider } from '@nestjs/common';
import { PrismaModule } from '@file/database';
import {
	ClientServicesRepository,
	InMemoryClientServicesRepository,
} from './client-services.repository';
import { PrismaClientServicesRepository } from './prisma-client-services.repository';

export const CLIENT_SERVICES_REPOSITORY = Symbol('CLIENT_SERVICES_REPOSITORY');

export const shouldUseInMemoryClientServicesRepository = () =>
	process.env.NODE_ENV === 'test' ||
	process.env.CLIENT_SERVICE_REGISTRY_DRIVER === 'memory';

export const createClientServicesRepositoryImports = () =>
	shouldUseInMemoryClientServicesRepository() ? [] : [PrismaModule];

export const createClientServicesRepositoryProvider =
	(): Provider<ClientServicesRepository> =>
		shouldUseInMemoryClientServicesRepository()
			? {
					provide: CLIENT_SERVICES_REPOSITORY,
					useClass: InMemoryClientServicesRepository,
				}
			: {
					provide: CLIENT_SERVICES_REPOSITORY,
					useClass: PrismaClientServicesRepository,
				};
