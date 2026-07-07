import { Controller, Get } from '@nestjs/common';
import { LifecycleConsumerStatusService } from './consumer/lifecycle-consumer-status.service';
import { LifecycleEventStoreService } from './consumer/lifecycle-event-store.service';

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
			service: 'lifecycle-consumer-tester',
			checkedAt: new Date().toISOString(),
			consumer,
			storedEvents: this.eventStore.count(),
		};
	}
}
