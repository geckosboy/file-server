import { randomUUID, timingSafeEqual } from 'crypto';

export const ADMIN_WEB_ACTOR_HEADER = 'x-file-admin-user';
export const ADMIN_WEB_PROXY_SECRET_HEADER = 'x-file-admin-proxy-secret';
export const ADMIN_WEB_REQUEST_ID_HEADER = 'x-request-id';

export interface AdminWebSession {
	actor: string;
	requestId: string;
}

export class AdminWebAuthenticationError extends Error {
	readonly status = 401;
}

export class AdminWebConfigurationError extends Error {
	readonly status = 503;
}

export function authenticateAdminWebHeaders(
	headers: Pick<Headers, 'get'>,
	environment: NodeJS.ProcessEnv = process.env,
): AdminWebSession {
	const nodeEnv = environment.NODE_ENV ?? 'development';
	if (
		nodeEnv === 'test' ||
		(nodeEnv !== 'production' && environment.ADMIN_WEB_AUTH_DISABLED === 'true')
	) {
		return {
			actor: normalize(headers.get(ADMIN_WEB_ACTOR_HEADER)) ?? 'local-admin',
			requestId:
				normalize(headers.get(ADMIN_WEB_REQUEST_ID_HEADER)) ?? randomUUID(),
		};
	}

	const configuredSecret = normalize(environment.ADMIN_WEB_PROXY_SECRET);
	if (!configuredSecret) {
		throw new AdminWebConfigurationError(
			'ADMIN_WEB_PROXY_SECRET 환경변수가 필요합니다.',
		);
	}
	const presentedSecret = normalize(headers.get(ADMIN_WEB_PROXY_SECRET_HEADER));
	const actor = normalize(headers.get(ADMIN_WEB_ACTOR_HEADER));
	if (
		!presentedSecret ||
		!actor ||
		!constantTimeEqual(presentedSecret, configuredSecret)
	) {
		throw new AdminWebAuthenticationError(
			'인증된 관리자 reverse proxy를 통해 접근해야 합니다.',
		);
	}

	return {
		actor,
		requestId:
			normalize(headers.get(ADMIN_WEB_REQUEST_ID_HEADER)) ?? randomUUID(),
	};
}

export function createAdminAuditHeaders(session: AdminWebSession) {
	return {
		'x-admin-actor': session.actor,
		'x-request-id': session.requestId,
	};
}

function normalize(value: string | undefined | null) {
	const trimmed = value?.trim();
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
