import { Controller, Get } from '@nestjs/common';
import { LifecycleConsumerStatusService } from './lifecycle-consumer-status.service';

@Controller('consumer')
export class ConsumerController {
	constructor(private readonly statusService: LifecycleConsumerStatusService) {}

	@Get('status')
	getStatus() {
		return this.statusService.getStatus();
	}
}
