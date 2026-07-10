import {
	CanActivate,
	ExecutionContext,
	Injectable,
	SetMetadata,
	UnauthorizedException,
	createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
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
export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';
export const INTERNAL_CLIENT_CONTEXT_HEADER = 'x-internal-client-context';
export const INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER =
	'x-internal-client-context-signature';

const ACTIVE_CLIENT_SERVICE_STATUS = 'ACTIVE';
const MAX_CORRELATION_ID_LENGTH = 128;
const INTERNAL_CONTEXT_DEFAULT_TTL_SECONDS = 30;
const INTERNAL_CONTEXT_MAX_TTL_SECONDS = 60;
const INTERNAL_CONTEXT_CLOCK_SKEW_SECONDS = 5;
const INTERNAL_SERVICE_ACCESS_METADATA = Symbol('internal-service-access');

export interface ClientServiceAuthContext {
	clientServiceId: string;
	clientServiceSlug: string;
	clientServiceName: string;
	clientServiceKeyId: string;
	keyPrefix: string;
	requestId: string;
	traceId?: string;
}

export interface InternalServiceAccessRequirement {
	audience: string;
	actions: readonly string[];
}

export interface InternalServiceAccessContext {
	audience: string;
	action: string;
	issuedAt: number;
	expiresAt: number;
}

export interface CreateInternalServiceForwardHeadersOptions {
	audience: string;
	action: string;
	ttlSeconds?: number;
	now?: Date;
}

export type ClientServiceTelemetryFields = Pick<
	ClientServiceAuthContext,
	'clientServiceId' | 'clientServiceSlug' | 'requestId' | 'traceId'
>;

export interface ClientServiceAuthenticatedRequest extends Request {
	clientServiceContext?: ClientServiceAuthContext;
	internalServiceAccess?: InternalServiceAccessContext;
	reqId?: string;
	requestLogContext?: {
		requestId: string;
		traceId?: string;
		clientServiceId?: string;
		clientServiceSlug?: string;
		clientServiceName?: string;
		clientServiceKeyId?: string;
	};
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

type InternalClientServiceIdentityPayload = Pick<
	ClientServiceAuthContext,
	| 'clientServiceId'
	| 'clientServiceSlug'
	| 'clientServiceName'
	| 'clientServiceKeyId'
	| 'keyPrefix'
	| 'requestId'
	| 'traceId'
>;

type InternalClientServiceContextPayload =
	InternalClientServiceIdentityPayload & InternalServiceAccessContext;

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
			readHeader(request, CLIENT_SERVICE_REQUEST_ID_HEADER) ??
				request.requestLogContext?.requestId ??
				request.reqId,
		);
		const traceId = normalizeOptionalCorrelationId(
			readHeader(request, CLIENT_SERVICE_TRACE_ID_HEADER),
		);

		removePresentedClientApiKey(request);
		request.headers[CLIENT_SERVICE_REQUEST_ID_HEADER] = requestId;
		request.clientServiceContext = {
			clientServiceId: authenticated.clientService.id,
			clientServiceSlug: authenticated.clientService.slug,
			clientServiceName: authenticated.clientService.name,
			clientServiceKeyId: authenticated.key.id,
			keyPrefix: authenticated.key.keyPrefix,
			requestId,
			traceId,
		};
		attachClientServiceLogContext(request, request.clientServiceContext);

		return true;
	}
}

@Injectable()
export class InternalServiceGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const request = context
			.switchToHttp()
			.getRequest<ClientServiceAuthenticatedRequest>();
		const internalApiKey = normalizeInternalApiKey(
			process.env.INTERNAL_API_KEY,
		);
		const presentedApiKey = readHeader(request, INTERNAL_API_KEY_HEADER);

		if (!internalApiKey) {
			throw new UnauthorizedException('내부 API 키 설정이 필요합니다.');
		}

		if (
			!presentedApiKey ||
			!isConstantTimeEqual(presentedApiKey, internalApiKey)
		) {
			throw new UnauthorizedException('내부 API 키가 올바르지 않습니다.');
		}

		const accessRequirement = readInternalServiceAccessRequirement(context);
		const signedContext = readSignedInternalClientServiceContext(
			request,
			internalApiKey,
			accessRequirement,
		);
		request.clientServiceContext = signedContext.context;
		request.internalServiceAccess = signedContext.access;
		request.headers[CLIENT_SERVICE_REQUEST_ID_HEADER] =
			request.clientServiceContext.requestId;
		if (request.clientServiceContext.traceId) {
			request.headers[CLIENT_SERVICE_TRACE_ID_HEADER] =
				request.clientServiceContext.traceId;
		}
		attachClientServiceLogContext(request, request.clientServiceContext);

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

export const getInternalServiceAccess = (
	request?: Pick<ClientServiceAuthenticatedRequest, 'internalServiceAccess'>,
): InternalServiceAccessContext | undefined => request?.internalServiceAccess;

export const InternalServiceAccess = (
	audience: string,
	actions: string | readonly string[],
) =>
	SetMetadata(INTERNAL_SERVICE_ACCESS_METADATA, {
		audience,
		actions: typeof actions === 'string' ? [actions] : [...actions],
	} satisfies InternalServiceAccessRequirement);

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

export const createInternalServiceForwardHeaders = (
	context: ClientServiceAuthContext | null | undefined,
	internalApiKey: string | null | undefined,
	options: CreateInternalServiceForwardHeadersOptions,
): Record<string, string> => {
	const normalizedInternalApiKey = normalizeInternalApiKey(internalApiKey);
	if (!normalizedInternalApiKey) {
		throw new Error('INTERNAL_API_KEY 설정이 필요합니다.');
	}
	if (!context) {
		throw new Error('클라이언트 서비스 컨텍스트가 필요합니다.');
	}

	const ttlSeconds = options.ttlSeconds ?? INTERNAL_CONTEXT_DEFAULT_TTL_SECONDS;
	if (
		!Number.isInteger(ttlSeconds) ||
		ttlSeconds <= 0 ||
		ttlSeconds > INTERNAL_CONTEXT_MAX_TTL_SECONDS
	) {
		throw new Error(
			`내부 클라이언트 컨텍스트 TTL은 1~${INTERNAL_CONTEXT_MAX_TTL_SECONDS}초여야 합니다.`,
		);
	}
	const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
	const payload: InternalClientServiceContextPayload = {
		...pickInternalClientServiceIdentityPayload(context),
		audience: readRequiredInternalOption(options.audience, 'audience'),
		action: readRequiredInternalOption(options.action, 'action'),
		issuedAt,
		expiresAt: issuedAt + ttlSeconds,
	};
	const encodedContext = encodeInternalContext(payload);

	return {
		[INTERNAL_API_KEY_HEADER]: normalizedInternalApiKey,
		[INTERNAL_CLIENT_CONTEXT_HEADER]: encodedContext,
		[INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER]: signInternalContext(
			encodedContext,
			normalizedInternalApiKey,
		),
	};
};

function attachClientServiceLogContext(
	request: ClientServiceAuthenticatedRequest,
	context: ClientServiceAuthContext,
) {
	const requestLogContext = request.requestLogContext ?? {
		requestId: context.requestId,
	};

	Object.assign(requestLogContext, {
		requestId: context.requestId,
		clientServiceId: context.clientServiceId,
		clientServiceSlug: context.clientServiceSlug,
		clientServiceName: context.clientServiceName,
		clientServiceKeyId: context.clientServiceKeyId,
		...(context.traceId ? { traceId: context.traceId } : {}),
	});
	request.reqId = context.requestId;
	request.requestLogContext = requestLogContext;
}

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

function removePresentedClientApiKey(request: Request) {
	delete request.headers[CLIENT_SERVICE_API_KEY_HEADER];
	const authorizationHeader = normalizeHeaderValue(
		request.headers.authorization,
	);
	if (authorizationHeader?.toLowerCase().startsWith('bearer ')) {
		delete request.headers.authorization;
	}
}

function readSignedInternalClientServiceContext(
	request: Request,
	internalApiKey: string,
	requirement: InternalServiceAccessRequirement,
): { context: ClientServiceAuthContext; access: InternalServiceAccessContext } {
	const encodedContext = readHeader(request, INTERNAL_CLIENT_CONTEXT_HEADER);
	const signature = readHeader(
		request,
		INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER,
	);
	if (!encodedContext || !signature) {
		throw new UnauthorizedException(
			'서명된 내부 클라이언트 컨텍스트가 필요합니다.',
		);
	}

	const expectedSignature = signInternalContext(encodedContext, internalApiKey);
	if (!isConstantTimeEqual(signature, expectedSignature)) {
		throw new UnauthorizedException(
			'내부 클라이언트 컨텍스트 서명이 올바르지 않습니다.',
		);
	}

	try {
		const payload = JSON.parse(
			decodeInternalContext(encodedContext),
		) as Partial<Record<keyof InternalClientServiceContextPayload, unknown>>;
		const identity = pickInternalClientServiceIdentityPayload(payload);
		const access = pickInternalServiceAccessContext(payload);
		assertInternalServiceAccess(access, requirement);
		return { context: identity, access };
	} catch (error) {
		if (error instanceof UnauthorizedException) {
			throw error;
		}
		throw new UnauthorizedException(
			'내부 클라이언트 컨텍스트를 해석할 수 없습니다.',
		);
	}
}

function pickInternalClientServiceIdentityPayload(
	context: Partial<Record<keyof InternalClientServiceContextPayload, unknown>>,
): InternalClientServiceIdentityPayload {
	const traceId = normalizeOptionalCorrelationId(
		readInternalStringField(context, 'traceId', { optional: true }),
	);

	return {
		clientServiceId: readInternalStringField(context, 'clientServiceId'),
		clientServiceSlug: readInternalStringField(context, 'clientServiceSlug'),
		clientServiceName: readInternalStringField(context, 'clientServiceName'),
		clientServiceKeyId: readInternalStringField(context, 'clientServiceKeyId'),
		keyPrefix: readInternalStringField(context, 'keyPrefix'),
		requestId: resolveCorrelationId(
			readInternalStringField(context, 'requestId', { optional: true }),
		),
		...(traceId ? { traceId } : {}),
	};
}

function pickInternalServiceAccessContext(
	context: Partial<Record<keyof InternalClientServiceContextPayload, unknown>>,
): InternalServiceAccessContext {
	return {
		audience: readInternalStringField(context, 'audience'),
		action: readInternalStringField(context, 'action'),
		issuedAt: readInternalIntegerField(context, 'issuedAt'),
		expiresAt: readInternalIntegerField(context, 'expiresAt'),
	};
}

function assertInternalServiceAccess(
	access: InternalServiceAccessContext,
	requirement: InternalServiceAccessRequirement,
) {
	const now = Math.floor(Date.now() / 1000);
	if (
		access.audience !== requirement.audience ||
		!requirement.actions.includes(access.action) ||
		access.issuedAt > now + INTERNAL_CONTEXT_CLOCK_SKEW_SECONDS ||
		access.expiresAt <= now ||
		access.expiresAt <= access.issuedAt ||
		access.expiresAt - access.issuedAt > INTERNAL_CONTEXT_MAX_TTL_SECONDS
	) {
		throw new UnauthorizedException(
			'내부 클라이언트 컨텍스트의 대상, 동작 또는 유효 시간이 올바르지 않습니다.',
		);
	}
}

function readInternalServiceAccessRequirement(
	context: ExecutionContext,
): InternalServiceAccessRequirement {
	const handler = context.getHandler?.();
	const controller = context.getClass?.();
	const requirement =
		(handler
			? Reflect.getMetadata(INTERNAL_SERVICE_ACCESS_METADATA, handler)
			: undefined) ??
		(controller
			? Reflect.getMetadata(INTERNAL_SERVICE_ACCESS_METADATA, controller)
			: undefined);
	if (
		!requirement ||
		typeof requirement.audience !== 'string' ||
		!Array.isArray(requirement.actions) ||
		requirement.actions.length === 0
	) {
		throw new UnauthorizedException(
			'내부 route의 audience/action 설정이 필요합니다.',
		);
	}
	return requirement as InternalServiceAccessRequirement;
}

function readInternalIntegerField(
	context: Partial<Record<keyof InternalClientServiceContextPayload, unknown>>,
	field: 'issuedAt' | 'expiresAt',
) {
	const value = context[field];
	if (!Number.isSafeInteger(value)) {
		throw new UnauthorizedException(
			'내부 클라이언트 컨텍스트 형식이 잘못되었습니다.',
		);
	}
	return value as number;
}

function readRequiredInternalOption(value: string, label: string) {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 128) {
		throw new Error(`내부 호출 ${label} 값이 필요합니다.`);
	}
	return trimmed;
}

function readInternalStringField(
	context: Partial<Record<keyof InternalClientServiceContextPayload, unknown>>,
	field: keyof InternalClientServiceContextPayload,
): string;
function readInternalStringField(
	context: Partial<Record<keyof InternalClientServiceContextPayload, unknown>>,
	field: keyof InternalClientServiceContextPayload,
	options: { optional: true },
): string | undefined;
function readInternalStringField(
	context: Partial<Record<keyof InternalClientServiceContextPayload, unknown>>,
	field: keyof InternalClientServiceContextPayload,
	options: { optional?: boolean } = {},
): string | undefined {
	const value = context[field];
	if (typeof value !== 'string') {
		if (options.optional) {
			return undefined;
		}
		throw new UnauthorizedException(
			'내부 클라이언트 컨텍스트 형식이 잘못되었습니다.',
		);
	}

	const trimmed = value.trim();
	if (!trimmed) {
		if (options.optional) {
			return undefined;
		}
		throw new UnauthorizedException(
			'내부 클라이언트 컨텍스트 형식이 잘못되었습니다.',
		);
	}

	return trimmed;
}

function encodeInternalContext(payload: InternalClientServiceContextPayload) {
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeInternalContext(encodedContext: string) {
	return Buffer.from(encodedContext, 'base64url').toString('utf8');
}

function signInternalContext(encodedContext: string, internalApiKey: string) {
	return createHmac('sha256', internalApiKey)
		.update(encodedContext)
		.digest('hex');
}

function normalizeInternalApiKey(
	value: string | null | undefined,
): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function isConstantTimeEqual(a: string, b: string): boolean {
	const aBuffer = Buffer.from(a);
	const bBuffer = Buffer.from(b);
	if (aBuffer.length !== bBuffer.length) {
		return false;
	}
	return timingSafeEqual(aBuffer, bBuffer);
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
