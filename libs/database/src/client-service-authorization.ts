import {
	ForbiddenException,
	HttpException,
	HttpStatus,
	Injectable,
	PayloadTooLargeException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
	matchesClientServicePathPattern,
	normalizeSafeRelativePath,
} from '@file/image-contracts';
import { PrismaService } from './prisma.service';
import type { ClientServiceAuthContext } from './client-service-auth';
import { incrementClientServiceAuthMetric } from './client-service-auth.metrics';

const ACTIVE_CLIENT_SERVICE_STATUS = 'ACTIVE';
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_RETENTION_MS = 5 * RATE_LIMIT_WINDOW_MS;

export const ClientServiceAction = {
	Read: 'read',
	Upload: 'upload',
	Delete: 'delete',
} as const;
export type ClientServiceAction =
	(typeof ClientServiceAction)[keyof typeof ClientServiceAction];

export interface ClientServiceAuthorizationInput {
	context: ClientServiceAuthContext;
	action: ClientServiceAction;
	normalizedPath: string;
	uploadBytes?: number;
	consumeRateLimit?: boolean;
}

export interface ClientServiceAuthorizationDecision {
	allowed: true;
	action: ClientServiceAction;
	normalizedPath: string;
	maxUploadBytes?: number;
	rateLimitPerMin?: number;
	matchedPolicyIds: string[];
}

type KeyWithPolicies = Prisma.ClientServiceKeyGetPayload<{
	include: { clientService: { include: { policies: true } } };
}>;

@Injectable()
export class ClientServiceAuthorizationService {
	private nextRateLimitCleanupAt = 0;

	constructor(private readonly prisma: PrismaService) {}

	async authorize(
		input: ClientServiceAuthorizationInput,
	): Promise<ClientServiceAuthorizationDecision> {
		const normalizedPath = normalizeSafeRelativePath(
			input.normalizedPath,
			'authorization path',
		);
		const key = await this.loadUsableKey(input.context);
		const matchingPolicies = key.clientService.policies.filter(
			(policy) =>
				isActionAllowedByPolicy(policy, input.action) &&
				matchesPolicyPath(normalizedPath, policy.pathPattern),
		);

		if (
			matchingPolicies.length === 0 ||
			!isActionAllowedByKeyScopes(key.scopes, input.action, normalizedPath)
		) {
			incrementClientServiceAuthMetric('authorizationDenials');
			throw new ForbiddenException(
				'이 클라이언트 서비스는 요청한 이미지 경로와 동작에 대한 권한이 없습니다.',
			);
		}

		const maxUploadBytes = minimumDefined(
			matchingPolicies.map((policy) => policy.maxUploadBytes),
		);
		if (
			input.action === ClientServiceAction.Upload &&
			input.uploadBytes !== undefined &&
			maxUploadBytes !== undefined &&
			input.uploadBytes > maxUploadBytes
		) {
			incrementClientServiceAuthMetric('authorizationDenials');
			throw new PayloadTooLargeException(
				`업로드 파일은 정책 제한 ${maxUploadBytes} bytes를 초과할 수 없습니다.`,
			);
		}

		const rateLimitPerMin = minimumDefined(
			matchingPolicies.map((policy) => policy.rateLimitPerMin),
		);
		if (input.consumeRateLimit !== false && rateLimitPerMin !== undefined) {
			await this.consumeRateLimit(input.context, input.action, rateLimitPerMin);
		}

		return {
			allowed: true,
			action: input.action,
			normalizedPath,
			maxUploadBytes,
			rateLimitPerMin,
			matchedPolicyIds: matchingPolicies.map((policy) => policy.id),
		};
	}

	async assertActiveContext(context: ClientServiceAuthContext): Promise<void> {
		await this.loadUsableKey(context);
	}

	private async loadUsableKey(
		context: ClientServiceAuthContext,
	): Promise<KeyWithPolicies> {
		const key = await this.prisma.clientServiceKey.findUnique({
			where: { id: context.clientServiceKeyId },
			include: { clientService: { include: { policies: true } } },
		});

		if (
			!key ||
			key.clientServiceId !== context.clientServiceId ||
			key.keyPrefix !== context.keyPrefix ||
			key.revokedAt ||
			(key.expiresAt && key.expiresAt.getTime() <= Date.now()) ||
			key.clientService.status !== ACTIVE_CLIENT_SERVICE_STATUS
		) {
			incrementClientServiceAuthMetric('authorizationDenials');
			throw new ForbiddenException(
				'클라이언트 서비스 인증 컨텍스트가 더 이상 유효하지 않습니다.',
			);
		}

		return key;
	}

	private async consumeRateLimit(
		context: ClientServiceAuthContext,
		action: ClientServiceAction,
		limit: number,
	): Promise<void> {
		const now = Date.now();
		const windowStartedAt = new Date(
			Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS,
		);
		const rows = await this.prisma.$queryRaw<Array<{ request_count: number }>>(
			Prisma.sql`
				INSERT INTO "client_service_rate_limit_windows" (
					"client_service_id",
					"client_service_key_id",
					"action",
					"window_started_at",
					"request_count",
					"updated_at"
				)
				VALUES (
					${context.clientServiceId},
					${context.clientServiceKeyId},
					${action},
					${windowStartedAt},
					1,
					CURRENT_TIMESTAMP
				)
				ON CONFLICT ("client_service_key_id", "action", "window_started_at")
				DO UPDATE SET
					"request_count" = "client_service_rate_limit_windows"."request_count" + 1,
					"updated_at" = CURRENT_TIMESTAMP
				WHERE "client_service_rate_limit_windows"."request_count" < ${limit}
				RETURNING "request_count"
			`,
		);

		if (rows.length === 0) {
			incrementClientServiceAuthMetric('rateLimitRejections');
			throw new HttpException(
				'클라이언트 서비스 요청 한도를 초과했습니다.',
				HttpStatus.TOO_MANY_REQUESTS,
			);
		}

		if (now >= this.nextRateLimitCleanupAt) {
			this.nextRateLimitCleanupAt = now + RATE_LIMIT_WINDOW_MS;
			await this.prisma.clientServiceRateLimitWindow
				.deleteMany({
					where: {
						windowStartedAt: {
							lt: new Date(now - RATE_LIMIT_RETENTION_MS),
						},
					},
				})
				.catch(() => undefined);
		}
	}
}

function matchesPolicyPath(normalizedPath: string, pathPattern: string) {
	try {
		return matchesClientServicePathPattern(normalizedPath, pathPattern);
	} catch {
		return false;
	}
}

function isActionAllowedByPolicy(
	policy: Pick<
		KeyWithPolicies['clientService']['policies'][number],
		'canRead' | 'canUpload' | 'canDelete'
	>,
	action: ClientServiceAction,
) {
	switch (action) {
		case ClientServiceAction.Read:
			return policy.canRead;
		case ClientServiceAction.Upload:
			return policy.canUpload;
		case ClientServiceAction.Delete:
			return policy.canDelete;
	}
}

function isActionAllowedByKeyScopes(
	scopes: Prisma.JsonValue | null,
	action: ClientServiceAction,
	normalizedPath: string,
) {
	if (!isJsonRecord(scopes)) return true;

	const actions = Array.isArray(scopes.actions)
		? scopes.actions.filter(
				(value): value is string => typeof value === 'string',
			)
		: undefined;
	const hasBooleanActionCap = (['read', 'upload', 'delete'] as const).some(
		(name) => Object.prototype.hasOwnProperty.call(scopes, name),
	);
	if (hasBooleanActionCap && scopes[action] !== true) {
		return false;
	}
	if (actions !== undefined && !actions.includes(action)) {
		return false;
	}

	if (scopes.pathPatterns === undefined) return true;
	if (!Array.isArray(scopes.pathPatterns) || scopes.pathPatterns.length === 0) {
		return false;
	}

	return scopes.pathPatterns.some((pattern) => {
		if (typeof pattern !== 'string') return false;
		try {
			return matchesClientServicePathPattern(normalizedPath, pattern);
		} catch {
			return false;
		}
	});
}

function isJsonRecord(
	value: Prisma.JsonValue | null,
): value is Prisma.JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function minimumDefined(values: Array<number | null>) {
	const defined = values.filter((value): value is number => value !== null);
	return defined.length ? Math.min(...defined) : undefined;
}
