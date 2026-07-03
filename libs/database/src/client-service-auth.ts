import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException,
	createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import {
	extractClientApiKeyPrefix,
	hashClientApiKey,
	isSameClientApiKeyHash,
} from './client-api-key';

export const CLIENT_SERVICE_API_KEY_HEADER = 'x-client-api-key';
export const CLIENT_SERVICE_REQUEST_ID_HEADER = 'x-request-id';
export const CLIENT_SERVICE_TRACE_ID_HEADER = 'x-trace-id';

const ACTIVE_CLIENT_SERVICE_STATUS = 'ACTIVE';
const MAX_CORRELATION_ID_LENGTH = 128;

export interface ClientServiceAuthContext {
	clientServiceId: string;
	clientServiceSlug: string;
	clientServiceName: string;
	clientServiceKeyId: string;
	keyPrefix: string;
	requestId: string;
	traceId?: string;
	/**
	 * 현재 요청 안에서 cache/resize/storage 내부 호출에만 전달한다.
	 * 로그, 응답, 텔레메트리 payload에 넣으면 안 된다.
	 */
	apiKey: string;
}

export type ClientServiceTelemetryFields = Pick<
	ClientServiceAuthContext,
	'clientServiceId' | 'clientServiceSlug' | 'requestId' | 'traceId'
>;

export interface ClientServiceAuthenticatedRequest extends Request {
	clientServiceContext?: ClientServiceAuthContext;
}

export interface AuthenticatedClientService {
	clientService: {
		id: string;
		slug: string;
		name: string;
		status: string;
	};
	key: {
		id: string;
		keyPrefix: string;
		expiresAt?: Date;
	};
}

type ClientServiceKeyWithService = Prisma.ClientServiceKeyGetPayload<{
	include: { clientService: true };
}>;

@Injectable()
export class ClientServiceAuthService {
	constructor(private readonly prisma: PrismaService) {}

	async authenticate(
		apiKey: string,
	): Promise<AuthenticatedClientService | null> {
		const normalizedApiKey = apiKey.trim();
		const keyPrefix = extractClientApiKeyPrefix(normalizedApiKey);
		if (!keyPrefix) {
			return null;
		}

		const key = await this.prisma.clientServiceKey.findUnique({
			where: { keyPrefix },
			include: { clientService: true },
		});

		if (!key || !isClientServiceKeyUsable(key, normalizedApiKey)) {
			return null;
		}

		await this.touchLastUsedAt(key.id);

		return {
			clientService: {
				id: key.clientService.id,
				slug: key.clientService.slug,
				name: key.clientService.name,
				status: key.clientService.status,
			},
			key: {
				id: key.id,
				keyPrefix: key.keyPrefix,
				expiresAt: key.expiresAt ?? undefined,
			},
		};
	}

	private async touchLastUsedAt(keyId: string) {
		try {
			await this.prisma.clientServiceKey.update({
				where: { id: keyId },
				data: { lastUsedAt: new Date() },
			});
		} catch {
			// 인증 성공 이후의 lastUsedAt 기록 실패는 요청 자체를 막지 않는다.
		}
	}
}

@Injectable()
export class ClientServiceApiKeyGuard implements CanActivate {
	constructor(private readonly authService: ClientServiceAuthService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context
			.switchToHttp()
			.getRequest<ClientServiceAuthenticatedRequest>();
		const apiKey = readClientServiceApiKey(request);

		if (!apiKey) {
			throw new UnauthorizedException('클라이언트 서비스 API 키가 필요합니다.');
		}

		const authenticated = await this.authService.authenticate(apiKey);
		if (!authenticated) {
			throw new UnauthorizedException(
				'클라이언트 서비스 API 키가 올바르지 않습니다.',
			);
		}

		const requestId = resolveCorrelationId(
			readHeader(request, CLIENT_SERVICE_REQUEST_ID_HEADER),
		);
		const traceId = normalizeOptionalCorrelationId(
			readHeader(request, CLIENT_SERVICE_TRACE_ID_HEADER),
		);

		request.headers[CLIENT_SERVICE_REQUEST_ID_HEADER] = requestId;
		request.clientServiceContext = {
			clientServiceId: authenticated.clientService.id,
			clientServiceSlug: authenticated.clientService.slug,
			clientServiceName: authenticated.clientService.name,
			clientServiceKeyId: authenticated.key.id,
			keyPrefix: authenticated.key.keyPrefix,
			requestId,
			traceId,
			apiKey,
		};

		return true;
	}
}

export const ClientServiceContext = createParamDecorator(
	(_data: unknown, context: ExecutionContext) =>
		getClientServiceContext(
			context.switchToHttp().getRequest<ClientServiceAuthenticatedRequest>(),
		),
);

export const getClientServiceContext = (
	request?: Pick<ClientServiceAuthenticatedRequest, 'clientServiceContext'>,
): ClientServiceAuthContext | undefined => request?.clientServiceContext;

export const createClientServiceTelemetryFields = (
	context?: ClientServiceAuthContext | null,
): Partial<ClientServiceTelemetryFields> => {
	if (!context) {
		return {};
	}

	return {
		clientServiceId: context.clientServiceId,
		clientServiceSlug: context.clientServiceSlug,
		requestId: context.requestId,
		...(context.traceId ? { traceId: context.traceId } : {}),
	};
};

export const createClientServiceForwardHeaders = (
	context?: ClientServiceAuthContext | null,
): Record<string, string> => {
	if (!context) {
		return {};
	}

	return {
		[CLIENT_SERVICE_API_KEY_HEADER]: context.apiKey,
		[CLIENT_SERVICE_REQUEST_ID_HEADER]: context.requestId,
		...(context.traceId
			? { [CLIENT_SERVICE_TRACE_ID_HEADER]: context.traceId }
			: {}),
	};
};

function isClientServiceKeyUsable(
	key: ClientServiceKeyWithService,
	apiKey: string,
): boolean {
	if (key.revokedAt) {
		return false;
	}

	if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
		return false;
	}

	if (key.clientService.status !== ACTIVE_CLIENT_SERVICE_STATUS) {
		return false;
	}

	return isSameClientApiKeyHash(key.keyHash, hashClientApiKey(apiKey));
}

function readClientServiceApiKey(request: Request): string | undefined {
	const explicitHeader = readHeader(request, CLIENT_SERVICE_API_KEY_HEADER);
	if (explicitHeader) {
		return explicitHeader;
	}

	const authorizationHeader = readHeader(request, 'authorization');
	if (!authorizationHeader) {
		return undefined;
	}

	const [scheme, value] = authorizationHeader.split(/\s+/, 2);
	return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}

function readHeader(request: Request, name: string): string | undefined {
	const header = request.header?.(name) ?? request.get?.(name);
	return normalizeHeaderValue(header);
}

function normalizeHeaderValue(
	value: string | string[] | undefined,
): string | undefined {
	const headerValue = Array.isArray(value) ? value[0] : value;
	const trimmed = headerValue?.trim();
	return trimmed ? trimmed : undefined;
}

function resolveCorrelationId(value: string | undefined): string {
	return normalizeOptionalCorrelationId(value) ?? randomUUID();
}

function normalizeOptionalCorrelationId(
	value: string | undefined,
): string | undefined {
	if (!value) {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= MAX_CORRELATION_ID_LENGTH
		? trimmed
		: undefined;
}
