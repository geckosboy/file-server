import { Module } from '@nestjs/common';
import {
	ClientServiceApiKeyGuard,
	ClientServiceAuthService,
} from './client-service-auth';
import { PrismaModule } from './prisma.module';

@Module({
	imports: [PrismaModule],
	providers: [ClientServiceAuthService, ClientServiceApiKeyGuard],
	exports: [ClientServiceAuthService, ClientServiceApiKeyGuard],
})
export class ClientServiceAuthModule {}
