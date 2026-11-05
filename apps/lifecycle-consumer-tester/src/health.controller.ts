import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LifecycleConsumerStatusService } from './consumer/lifecycle-consumer-status.service';
import { LifecycleEventStoreService } from './consumer/lifecycle-event-store.service';

const SERVICE_NAME = 'lifecycle-consumer-tester';

@Controller('health')
export class HealthController {
	constructor(
		private readonly statusService: LifecycleConsumerStatusService,
		private readonly eventStore: LifecycleEventStoreService,
	) {}

	@Get()
	getHealth() {
		const consumer = this.statusService.getStatus();
		return {
			ok: consumer.enabled ? consumer.connected : true,
			service: SERVICE_NAME,
			checkedAt: new Date().toISOString(),
			consumer,
			storedEvents: this.eventStore.count(),
		};
	}

	@Get('live')
	getLiveness() {
		return {
			ok: true,
			service: SERVICE_NAME,
			checkedAt: new Date().toISOString(),
		};
	}

	@Get('ready')
	getReadiness(@Res({ passthrough: true }) response: Response) {
		const consumer = this.statusService.getStatus();
		const ok = consumer.enabled && consumer.connected;
		response.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

		return {
			ok,
			service: SERVICE_NAME,
			checkedAt: new Date().toISOString(),
			consumer,
			storedEvents: this.eventStore.count(),
		};
	}
}
