import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AppConfig } from 'src/config';

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
	constructor(private readonly appConfig: AppConfig) {}

	canActivate(context: ExecutionContext): boolean {
		const apiKey = this.appConfig.INTERNAL_API_KEY;
		if (!apiKey) {
			return true;
		}

		const request = context.switchToHttp().getRequest<Request>();
		if (request.header('x-internal-api-key') === apiKey) {
			return true;
		}

		throw new UnauthorizedException('내부 API 키가 올바르지 않습니다.');
	}
}
