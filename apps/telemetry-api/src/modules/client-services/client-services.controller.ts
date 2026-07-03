import {
	Body,
	Controller,
	Get,
	Param,
	Patch,
	Post,
	UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { ClientServicesService } from './client-services.service';

@UseGuards(AdminAuthGuard)
@Controller('api/admin/client-services')
export class ClientServicesController {
	constructor(private readonly clientServicesService: ClientServicesService) {}

	@Get()
	listServices() {
		return this.clientServicesService.listServices();
	}

	@Post()
	createService(@Body() body: unknown) {
		return this.clientServicesService.createService(body);
	}

	@Get(':id')
	getService(@Param('id') id: string) {
		return this.clientServicesService.getService(id);
	}

	@Patch(':id')
	updateService(@Param('id') id: string, @Body() body: unknown) {
		return this.clientServicesService.updateService(id, body);
	}

	@Post(':id/keys')
	createKey(@Param('id') id: string, @Body() body: unknown) {
		return this.clientServicesService.createKey(id, body);
	}

	@Post(':id/keys/:keyId/revoke')
	revokeKey(@Param('id') id: string, @Param('keyId') keyId: string) {
		return this.clientServicesService.revokeKey(id, keyId);
	}

	@Post(':id/lifecycle-subscriptions')
	createLifecycleSubscription(@Param('id') id: string, @Body() body: unknown) {
		return this.clientServicesService.createLifecycleSubscription(id, body);
	}

	@Patch(':id/lifecycle-subscriptions/:subscriptionId')
	updateLifecycleSubscription(
		@Param('id') id: string,
		@Param('subscriptionId') subscriptionId: string,
		@Body() body: unknown,
	) {
		return this.clientServicesService.updateLifecycleSubscription(
			id,
			subscriptionId,
			body,
		);
	}
}
