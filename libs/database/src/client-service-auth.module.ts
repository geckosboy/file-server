import { Module } from '@nestjs/common';
import {
	ClientServiceApiKeyGuard,
	ClientServiceAuthService,
	InternalServiceGuard,
} from './client-service-auth';
import { PrismaModule } from './prisma.module';
import { ClientServiceAuthorizationService } from './client-service-authorization';

@Module({
	imports: [PrismaModule],
	providers: [
		ClientServiceAuthService,
		ClientServiceAuthorizationService,
		ClientServiceApiKeyGuard,
		InternalServiceGuard,
	],
	exports: [
		ClientServiceAuthService,
		ClientServiceAuthorizationService,
		ClientServiceApiKeyGuard,
		InternalServiceGuard,
	],
})
export class ClientServiceAuthModule {}
