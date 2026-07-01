import { Injectable } from '@nestjs/common';

@Injectable()
export class TelemetryConfigService {
	readonly adminToken = process.env.TELEMETRY_ADMIN_TOKEN ?? 'test-admin-token';
}
