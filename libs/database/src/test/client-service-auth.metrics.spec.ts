import {
	getClientServiceAuthMetricsSnapshot,
	incrementClientServiceAuthMetric,
	resetClientServiceAuthMetricsForTesting,
} from '.././client-service-auth.metrics';

describe('client service auth metrics', () => {
	beforeEach(() => resetClientServiceAuthMetricsForTesting());

	it('고정 counter snapshot을 defensive copy로 반환한다', () => {
		incrementClientServiceAuthMetric('externalApiKeyDenials');
		const snapshot = getClientServiceAuthMetricsSnapshot();
		(snapshot as { externalApiKeyDenials: number }).externalApiKeyDenials = 99;

		expect(getClientServiceAuthMetricsSnapshot()).toEqual({
			externalApiKeyDenials: 1,
			internalContextDenials: 0,
			authorizationDenials: 0,
			rateLimitRejections: 0,
		});
	});

	it('counter가 Number.MAX_SAFE_INTEGER에서 포화한다', () => {
		resetClientServiceAuthMetricsForTesting({
			rateLimitRejections: Number.MAX_SAFE_INTEGER,
		});
		incrementClientServiceAuthMetric('rateLimitRejections');

		expect(getClientServiceAuthMetricsSnapshot().rateLimitRejections).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	});
});
