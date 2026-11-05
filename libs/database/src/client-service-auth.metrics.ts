export interface ClientServiceAuthMetricsSnapshot {
	externalApiKeyDenials: number;
	internalContextDenials: number;
	authorizationDenials: number;
	rateLimitRejections: number;
}

export type ClientServiceAuthMetric = keyof ClientServiceAuthMetricsSnapshot;

let metrics = createEmptyMetrics();

export function getClientServiceAuthMetricsSnapshot(): ClientServiceAuthMetricsSnapshot {
	return { ...metrics };
}

export function resetClientServiceAuthMetricsForTesting(
	initial: Partial<ClientServiceAuthMetricsSnapshot> = {},
): void {
	metrics = { ...createEmptyMetrics(), ...initial };
}

export function incrementClientServiceAuthMetric(
	metric: ClientServiceAuthMetric,
): void {
	metrics[metric] =
		metrics[metric] >= Number.MAX_SAFE_INTEGER
			? Number.MAX_SAFE_INTEGER
			: metrics[metric] + 1;
}

function createEmptyMetrics(): ClientServiceAuthMetricsSnapshot {
	return {
		externalApiKeyDenials: 0,
		internalContextDenials: 0,
		authorizationDenials: 0,
		rateLimitRejections: 0,
	};
}
