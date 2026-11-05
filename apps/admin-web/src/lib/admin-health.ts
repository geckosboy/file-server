const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const ADMIN_API_PATH_SUFFIX = '/api/admin';

export const getAdminHealthTimeoutMs = (
	environment: NodeJS.ProcessEnv = process.env,
) => {
	const parsed = Number(environment.ADMIN_WEB_HEALTH_TIMEOUT_MS);
	return Number.isInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_HEALTH_TIMEOUT_MS;
};

export const getTelemetryReadyUrl = (
	environment: NodeJS.ProcessEnv = process.env,
) => {
	const configured = environment.TELEMETRY_API_BASE_URL?.trim();
	if (!configured) {
		throw new Error('telemetry_api_not_configured');
	}

	const url = new URL(configured);
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username ||
		url.password
	) {
		throw new Error('telemetry_api_url_invalid');
	}

	const pathname = url.pathname.replace(/\/+$/, '');
	if (
		pathname &&
		pathname !== '/' &&
		!pathname.endsWith(ADMIN_API_PATH_SUFFIX)
	) {
		throw new Error('telemetry_api_path_invalid');
	}
	const servicePrefix = pathname.endsWith(ADMIN_API_PATH_SUFFIX)
		? pathname.slice(0, -ADMIN_API_PATH_SUFFIX.length)
		: '';
	url.pathname = `${servicePrefix}/health/ready`;
	url.search = '';
	url.hash = '';
	return url;
};

export const createHealthForwardHeaders = (incoming: Pick<Headers, 'get'>) => {
	const headers = new Headers();
	forwardCorrelationHeader(incoming, headers, 'x-request-id');
	forwardCorrelationHeader(incoming, headers, 'x-trace-id');
	forwardCorrelationHeader(incoming, headers, 'traceparent');
	return headers;
};

const forwardCorrelationHeader = (
	incoming: Pick<Headers, 'get'>,
	forwarded: Headers,
	name: string,
) => {
	const value = incoming.get(name)?.trim();
	if (value && value.length <= 256) {
		forwarded.set(name, value);
	}
};
