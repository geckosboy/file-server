export const CACHE_HEALTH_METRICS = Symbol('CACHE_HEALTH_METRICS');
export const CACHE_SINGLEFLIGHT_HEALTH_METRICS = Symbol(
	'CACHE_SINGLEFLIGHT_HEALTH_METRICS',
);

export interface CacheHealthMetricsSource {
	getMetrics?: () => Record<string, unknown>;
}

export interface CacheSingleflightHealthMetricsSource {
	getSingleflightMetrics?: () => Record<string, unknown>;
}
