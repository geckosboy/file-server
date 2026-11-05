import { Controller, Delete, Get, Query } from '@nestjs/common';
import {
	LifecycleEventQuery,
	LifecycleEventStoreService,
} from './lifecycle-event-store.service';
import { LifecycleConsumerStatusService } from './lifecycle-consumer-status.service';

@Controller('events')
export class EventsController {
	constructor(
		private readonly eventStore: LifecycleEventStoreService,
		private readonly statusService: LifecycleConsumerStatusService,
	) {}

	@Get()
	listEvents(@Query() query: LifecycleEventQuery) {
		const items = this.eventStore.list(query);
		return {
			count: items.length,
			items,
		};
	}

	@Delete()
	clearEvents() {
		const deleted = this.eventStore.clear();
		this.statusService.markCleared();
		return { deleted };
	}
}
