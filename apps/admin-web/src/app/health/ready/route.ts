import { NextRequest, NextResponse } from 'next/server';
import {
	createHealthForwardHeaders,
	getAdminHealthTimeoutMs,
	getTelemetryReadyUrl,
} from '@/lib/admin-health';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
	const checkedAt = new Date().toISOString();
	let response: Response | undefined;
	try {
		response = await fetch(getTelemetryReadyUrl(), {
			method: 'GET',
			headers: createHealthForwardHeaders(request.headers),
			signal: AbortSignal.timeout(getAdminHealthTimeoutMs()),
			cache: 'no-store',
			redirect: 'error',
		});
		if (!response.ok) {
			return readinessUnavailable(checkedAt, {
				reason: 'dependency_status',
				status: response.status,
			});
		}

		return NextResponse.json({
			ok: true,
			service: 'admin-web',
			checkedAt,
			dependencies: {
				telemetryApi: { ok: true, status: response.status },
			},
		});
	} catch (error) {
		return readinessUnavailable(checkedAt, {
			reason: isTimeoutError(error) ? 'timeout' : 'unavailable',
		});
	} finally {
		await response?.body?.cancel().catch(() => undefined);
	}
}

function readinessUnavailable(
	checkedAt: string,
	dependency: { reason: string; status?: number },
) {
	return NextResponse.json(
		{
			ok: false,
			service: 'admin-web',
			checkedAt,
			dependencies: {
				telemetryApi: { ok: false, ...dependency },
			},
		},
		{ status: 503 },
	);
}

function isTimeoutError(error: unknown) {
	if (typeof error !== 'object' || error === null || !('name' in error)) {
		return false;
	}
	const name = Reflect.get(error, 'name');
	return name === 'TimeoutError' || name === 'AbortError';
}
