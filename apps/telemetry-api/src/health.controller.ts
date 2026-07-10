import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AdminQueryService } from './modules/admin/admin-query.service';

@Controller()
export class HealthController {
	constructor(private readonly queryService: AdminQueryService) {}

	@Get('/health/live')
	getLive() {
		return {
			ok: true,
			service: 'telemetry-api',
			checkedAt: new Date().toISOString(),
		};
	}

	@Get('/health/ready')
	async getReady() {
		const health = await this.queryService.getHealth();
		if (!health.ok) {
			throw new ServiceUnavailableException(health);
		}
		return health;
	}

	@Get('/health-check')
	async healthCheck(): Promise<string> {
		await this.getReady();
		return 'OK';
	}
}
