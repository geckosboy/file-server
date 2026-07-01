import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { TelemetryConfigService } from './telemetry-config.service';

@Injectable()
export class AdminAuthGuard implements CanActivate {
	constructor(private readonly config: TelemetryConfigService) {}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		const header = request.headers['x-admin-token'];
		const token = Array.isArray(header) ? header[0] : header;
		if (token !== this.config.adminToken) {
			throw new UnauthorizedException('admin token is required');
		}

		return true;
	}
}
