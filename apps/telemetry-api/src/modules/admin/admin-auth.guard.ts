import {
	CanActivate,
	createParamDecorator,
	ExecutionContext,
	Injectable,
	UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { TelemetryConfigService } from './telemetry-config.service';
import type { AdminActionContext } from '../client-services/client-services.types';

export const ADMIN_ACTOR_HEADER = 'x-admin-actor';
export const ADMIN_REQUEST_ID_HEADER = 'x-request-id';

export interface AdminAuthenticatedRequest extends Request {
	adminContext?: AdminActionContext;
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
	constructor(private readonly config: TelemetryConfigService) {}

	canActivate(context: ExecutionContext): boolean {
		const request = context
			.switchToHttp()
			.getRequest<AdminAuthenticatedRequest>();
		const header = request.headers['x-admin-token'];
		const token = Array.isArray(header) ? header[0] : header;
		if (!token || !constantTimeEqual(token, this.config.adminToken)) {
			throw new UnauthorizedException('admin token is required');
		}

		const actor = normalizeHeader(request.headers[ADMIN_ACTOR_HEADER]);
		const requestId =
			normalizeHeader(request.headers[ADMIN_REQUEST_ID_HEADER]) ?? randomUUID();
		request.headers[ADMIN_REQUEST_ID_HEADER] = requestId;
		request.adminContext = {
			actor: actor ?? `admin-token:${tokenFingerprint(token)}`,
			requestId,
		};

		return true;
	}
}

export const AdminRequestContext = createParamDecorator(
	(_data: unknown, context: ExecutionContext): AdminActionContext => {
		const request = context
			.switchToHttp()
			.getRequest<AdminAuthenticatedRequest>();
		if (!request.adminContext) {
			throw new UnauthorizedException('admin context is required');
		}
		return request.adminContext;
	},
);

function normalizeHeader(value: string | string[] | undefined) {
	const candidate = Array.isArray(value) ? value[0] : value;
	const trimmed = candidate?.trim();
	return trimmed && trimmed.length <= 128 ? trimmed : undefined;
}

function constantTimeEqual(left: string, right: string) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return (
		leftBuffer.length === rightBuffer.length &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}

function tokenFingerprint(token: string) {
	return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
