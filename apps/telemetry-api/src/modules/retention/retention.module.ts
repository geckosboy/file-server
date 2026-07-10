import { Module } from '@nestjs/common';
import { PrismaModule } from '@file/database';
import { databaseRetentionConfigProvider } from './database-retention.config';
import { DatabaseRetentionService } from './database-retention.service';

@Module({
	imports: [PrismaModule],
	providers: [databaseRetentionConfigProvider, DatabaseRetentionService],
	exports: [DatabaseRetentionService],
})
export class RetentionModule {}

export const createRetentionModuleImports = (
	env: NodeJS.ProcessEnv = process.env,
) =>
	env.NODE_ENV === 'test' ||
	env.TELEMETRY_STORAGE_DRIVER === 'memory' ||
	env.LIFECYCLE_STORAGE_DRIVER === 'memory'
		? []
		: [RetentionModule];
