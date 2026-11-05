import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard, AdminRequestContext } from '../admin/admin-auth.guard';
import type { AdminActionContext } from './client-services.types';
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
	createKey(
		@Param('id') id: string,
		@Body() body: unknown,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.createKey(id, body, adminContext);
	}

	@Post(':id/keys/:keyId/revoke')
	revokeKey(
		@Param('id') id: string,
		@Param('keyId') keyId: string,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.revokeKey(id, keyId, adminContext);
	}

	@Post(':id/policies')
	createPolicy(
		@Param('id') id: string,
		@Body() body: unknown,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.createPolicy(id, body, adminContext);
	}

	@Patch(':id/policies/:policyId')
	updatePolicy(
		@Param('id') id: string,
		@Param('policyId') policyId: string,
		@Body() body: unknown,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.updatePolicy(
			id,
			policyId,
			body,
			adminContext,
		);
	}

	@Delete(':id/policies/:policyId')
	deletePolicy(
		@Param('id') id: string,
		@Param('policyId') policyId: string,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.deletePolicy(id, policyId, adminContext);
	}

	@Get(':id/audit-logs')
	listAuditLogs(@Param('id') id: string) {
		return this.clientServicesService.listAuditLogs(id);
	}

	@Post(':id/lifecycle-subscriptions')
	createLifecycleSubscription(
		@Param('id') id: string,
		@Body() body: unknown,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.createLifecycleSubscription(
			id,
			body,
			adminContext,
		);
	}

	@Patch(':id/lifecycle-subscriptions/:subscriptionId')
	updateLifecycleSubscription(
		@Param('id') id: string,
		@Param('subscriptionId') subscriptionId: string,
		@Body() body: unknown,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.updateLifecycleSubscription(
			id,
			subscriptionId,
			body,
			adminContext,
		);
	}

	@Get(':id/image-resize-policy')
	getImageResizePolicy(@Param('id') id: string) {
		return this.clientServicesService.getImageResizePolicy(id);
	}

	@Patch(':id/image-resize-policy')
	updateImageResizePolicy(
		@Param('id') id: string,
		@Body() body: unknown,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.updateImageResizePolicy(
			id,
			body,
			adminContext,
		);
	}

	@Post(':id/image-resize-policy/variants')
	createImageResizeVariant(
		@Param('id') id: string,
		@Body() body: unknown,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.createImageResizeVariant(
			id,
			body,
			adminContext,
		);
	}

	@Patch(':id/image-resize-policy/variants/:variantId')
	updateImageResizeVariant(
		@Param('id') id: string,
		@Param('variantId') variantId: string,
		@Body() body: unknown,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.updateImageResizeVariant(
			id,
			variantId,
			body,
			adminContext,
		);
	}

	@Delete(':id/image-resize-policy/variants/:variantId')
	deleteImageResizeVariant(
		@Param('id') id: string,
		@Param('variantId') variantId: string,
		@AdminRequestContext() adminContext: AdminActionContext,
	) {
		return this.clientServicesService.deleteImageResizeVariant(
			id,
			variantId,
			adminContext,
		);
	}
}
