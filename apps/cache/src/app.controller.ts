import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppHealthService } from './app-health.service';

@Controller()
export class AppController {
	constructor(private readonly healthService: AppHealthService) {}

	@Get('/health/live')
	healthLive() {
		return this.healthService.getLive();
	}

	@Get('/health/ready')
	async healthReady() {
		const health = await this.healthService.getReady();
		if (!health.ok) throw new ServiceUnavailableException(health);
		return health;
	}

	@Get('/health-check')
	async healthCheck(): Promise<string> {
		await this.healthReady();
		return 'OK';
	}
}
