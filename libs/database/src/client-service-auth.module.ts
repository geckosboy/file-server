import { Module } from '@nestjs/common';
import {
	ClientServiceApiKeyGuard,
	ClientServiceAuthService,
	InternalServiceGuard,
} from './client-service-auth';
import { PrismaModule } from './prisma.module';

@Module({
	imports: [PrismaModule],
	providers: [
		ClientServiceAuthService,
		ClientServiceApiKeyGuard,
		InternalServiceGuard,
	],
	exports: [
		ClientServiceAuthService,
		ClientServiceApiKeyGuard,
		InternalServiceGuard,
	],
})
export class ClientServiceAuthModule {}
