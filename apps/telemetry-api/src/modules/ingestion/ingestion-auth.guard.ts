import {
	CanActivate,
	ExecutionContext,
	Injectable,
	NotFoundException,
	UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { TelemetryConfigService } from '../admin/telemetry-config.service';

export const TELEMETRY_INGESTION_TOKEN_HEADER = 'x-ingestion-token';

@Injectable()
export class IngestionAuthGuard implements CanActivate {
	constructor(private readonly config: TelemetryConfigService) {}

	canActivate(context: ExecutionContext) {
		if (!this.config.httpIngestionEnabled) {
			throw new NotFoundException('HTTP ingestion endpoint is disabled');
		}
		const request = context.switchToHttp().getRequest<Request>();
		const presented =
			readHeader(request, TELEMETRY_INGESTION_TOKEN_HEADER) ??
			readBearerToken(request);
		if (
			!presented ||
			!this.config.ingestionToken ||
			!constantTimeEqual(presented, this.config.ingestionToken)
		) {
			throw new UnauthorizedException('ingestion token is required');
		}
		return true;
	}
}

function readHeader(request: Request, name: string) {
	const value = request.headers[name];
	const candidate = Array.isArray(value) ? value[0] : value;
	const trimmed = candidate?.trim();
	return trimmed || undefined;
}

function readBearerToken(request: Request) {
	const authorization = readHeader(request, 'authorization');
	if (!authorization) return undefined;
	const [scheme, token] = authorization.split(/\s+/, 2);
	return scheme?.toLowerCase() === 'bearer' ? token : undefined;
}

function constantTimeEqual(left: string, right: string) {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return (
		leftBuffer.length === rightBuffer.length &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}
