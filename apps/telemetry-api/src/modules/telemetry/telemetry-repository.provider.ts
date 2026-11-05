import { Provider } from '@nestjs/common';
import { PrismaModule } from '@file/database';
import { PrismaTelemetryRepository } from './prisma-telemetry.repository';
import {
	InMemoryTelemetryRepository,
	TelemetryRepository,
} from './telemetry.repository';

export const TELEMETRY_REPOSITORY = Symbol('TELEMETRY_REPOSITORY');

export const shouldUseInMemoryTelemetryRepository = () =>
	process.env.NODE_ENV === 'test' ||
	process.env.TELEMETRY_STORAGE_DRIVER === 'memory';

export const createTelemetryRepositoryImports = () =>
	shouldUseInMemoryTelemetryRepository() ? [] : [PrismaModule];

export const createTelemetryRepositoryProvider =
	(): Provider<TelemetryRepository> =>
		shouldUseInMemoryTelemetryRepository()
			? {
					provide: TELEMETRY_REPOSITORY,
					useClass: InMemoryTelemetryRepository,
				}
			: {
					provide: TELEMETRY_REPOSITORY,
					useClass: PrismaTelemetryRepository,
				};
