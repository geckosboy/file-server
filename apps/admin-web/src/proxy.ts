import { NextRequest, NextResponse } from 'next/server';
import {
	ADMIN_WEB_ACTOR_HEADER,
	ADMIN_WEB_REQUEST_ID_HEADER,
	AdminWebAuthenticationError,
	AdminWebConfigurationError,
	authenticateAdminWebHeaders,
} from './lib/admin-auth-policy';

export function proxy(request: NextRequest) {
	if (
		request.nextUrl.pathname === '/health/live' ||
		request.nextUrl.pathname === '/health/ready'
	) {
		return NextResponse.next();
	}
	try {
		const session = authenticateAdminWebHeaders(request.headers);
		const forwardedHeaders = new Headers(request.headers);
		forwardedHeaders.set(ADMIN_WEB_ACTOR_HEADER, session.actor);
		forwardedHeaders.set(ADMIN_WEB_REQUEST_ID_HEADER, session.requestId);
		return NextResponse.next({ request: { headers: forwardedHeaders } });
	} catch (error) {
		if (
			error instanceof AdminWebAuthenticationError ||
			error instanceof AdminWebConfigurationError
		) {
			return new NextResponse(error.message, { status: error.status });
		}
		throw error;
	}
}

export const config = {
	matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
