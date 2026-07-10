import {
	TelemetryApiError,
	buildClientServiceImageResizePolicyUrl,
	buildClientServiceImageResizeVariantUrl,
	buildClientServiceImageResizeVariantsUrl,
	buildClientServiceLifecycleSubscriptionUrl,
	buildClientServiceLifecycleSubscriptionsUrl,
	buildClientServicePoliciesUrl,
	buildClientServicePolicyUrl,
	buildClientServiceKeyRevokeUrl,
	buildClientServiceKeysUrl,
	buildClientServiceUrl,
	buildClientServicesUrl,
	buildDashboardSummaryUrl,
	buildEventsUrl,
	buildImagesUrl,
	buildImageResizeRecommendationsUrl,
	buildLifecycleEventsUrl,
	fetchImages,
	fetchTelemetryJson,
	getTelemetryApiBaseUrl,
	getTelemetryAdminToken,
	isAdminFixtureFallbackEnabled,
	toMetricDisplay,
} from '.././telemetry-api';

describe('텔레메트리 API 클라이언트', () => {
	const originalTelemetryAdminToken = process.env.TELEMETRY_ADMIN_TOKEN;
	const originalPublicTelemetryAdminToken =
		process.env.NEXT_PUBLIC_TELEMETRY_ADMIN_TOKEN;
	const originalNodeEnv = process.env.NODE_ENV;
	const originalTelemetryApiBaseUrl = process.env.TELEMETRY_API_BASE_URL;
	const originalPublicTelemetryApiBaseUrl =
		process.env.NEXT_PUBLIC_TELEMETRY_API_BASE_URL;
	const originalFixtureFlag = process.env.ADMIN_WEB_ENABLE_FIXTURES;

	afterEach(() => {
		if (originalTelemetryAdminToken === undefined) {
			delete process.env.TELEMETRY_ADMIN_TOKEN;
		} else {
			process.env.TELEMETRY_ADMIN_TOKEN = originalTelemetryAdminToken;
		}
		if (originalPublicTelemetryAdminToken === undefined) {
			delete process.env.NEXT_PUBLIC_TELEMETRY_ADMIN_TOKEN;
		} else {
			process.env.NEXT_PUBLIC_TELEMETRY_ADMIN_TOKEN =
				originalPublicTelemetryAdminToken;
		}
		restoreEnv('NODE_ENV', originalNodeEnv);
		restoreEnv('TELEMETRY_API_BASE_URL', originalTelemetryApiBaseUrl);
		restoreEnv(
			'NEXT_PUBLIC_TELEMETRY_API_BASE_URL',
			originalPublicTelemetryApiBaseUrl,
		);
		restoreEnv('ADMIN_WEB_ENABLE_FIXTURES', originalFixtureFlag);
		jest.restoreAllMocks();
	});

	it('대시보드 요약 API URL에 기간 쿼리를 포함한다', () => {
		const url = new URL(
			buildDashboardSummaryUrl(
				{
					from: '2026-07-01T00:00:00.000Z',
					to: '2026-07-02T00:00:00.000Z',
					clientServiceId: 'svc-catalog',
				},
				'https://telemetry.test/api/admin',
			),
		);

		expect(url.pathname).toBe('/api/admin/dashboard/summary');
		expect(url.searchParams.get('from')).toBe('2026-07-01T00:00:00.000Z');
		expect(url.searchParams.get('to')).toBe('2026-07-02T00:00:00.000Z');
		expect(url.searchParams.get('clientServiceId')).toBe('svc-catalog');
	});

	it('이벤트 목록 API URL에 필터와 cursor를 포함한다', () => {
		const url = new URL(
			buildEventsUrl(
				{
					eventType: 'image.cache.miss',
					sourceApp: 'cache',
					status: 'success',
					clientServiceId: 'svc-catalog',
					cursor: 'cursor-1',
					limit: 50,
				},
				'https://telemetry.test/api/admin',
			),
		);

		expect(url.pathname).toBe('/api/admin/events');
		expect(url.searchParams.get('eventType')).toBe('image.cache.miss');
		expect(url.searchParams.get('sourceApp')).toBe('cache');
		expect(url.searchParams.get('status')).toBe('success');
		expect(url.searchParams.get('clientServiceId')).toBe('svc-catalog');
		expect(url.searchParams.get('cursor')).toBe('cursor-1');
		expect(url.searchParams.get('limit')).toBe('50');
	});

	it('lifecycle 이벤트 목록 API URL에 업무 이벤트 필터를 포함한다', () => {
		const url = new URL(
			buildLifecycleEventsUrl(
				{
					eventType: 'image.upload.failed',
					status: 'failed',
					imageKey: 'products/main/broken.png',
					clientServiceId: 'svc-catalog',
					cursor: 'life-cursor-1',
					limit: 50,
				},
				'https://telemetry.test/api/admin',
			),
		);

		expect(url.pathname).toBe('/api/admin/lifecycle-events');
		expect(url.searchParams.get('eventType')).toBe('image.upload.failed');
		expect(url.searchParams.get('status')).toBe('failed');
		expect(url.searchParams.get('imageKey')).toBe('products/main/broken.png');
		expect(url.searchParams.get('clientServiceId')).toBe('svc-catalog');
		expect(url.searchParams.get('cursor')).toBe('life-cursor-1');
		expect(url.searchParams.get('limit')).toBe('50');
	});

	it('이미지 목록 API URL에 검색어와 정렬을 포함한다', () => {
		const url = new URL(
			buildImagesUrl(
				{
					q: 'hero',
					sort: 'cacheMisses',
					order: 'desc',
					clientServiceSlug: 'catalog-api',
				},
				'https://telemetry.test/api/admin',
			),
		);

		expect(url.pathname).toBe('/api/admin/images');
		expect(url.searchParams.get('q')).toBe('hero');
		expect(url.searchParams.get('sort')).toBe('cacheMisses');
		expect(url.searchParams.get('order')).toBe('desc');
		expect(url.searchParams.get('clientServiceSlug')).toBe('catalog-api');
	});

	it('리사이징 추천 API URL에 서비스와 추천 임계값을 포함한다', () => {
		const url = new URL(
			buildImageResizeRecommendationsUrl(
				{
					clientServiceId: 'svc-catalog',
					minRequests: 3,
					limit: 25,
				},
				'https://telemetry.test/api/admin',
			),
		);

		expect(url.pathname).toBe('/api/admin/image-resize-recommendations');
		expect(url.searchParams.get('clientServiceId')).toBe('svc-catalog');
		expect(url.searchParams.get('minRequests')).toBe('3');
		expect(url.searchParams.get('limit')).toBe('25');
	});

	it('서비스 레지스트리 API URL을 만든다', () => {
		expect(buildClientServicesUrl('https://telemetry.test/api/admin')).toBe(
			'https://telemetry.test/api/admin/client-services',
		);
		expect(
			buildClientServiceUrl('svc-1', 'https://telemetry.test/api/admin'),
		).toBe('https://telemetry.test/api/admin/client-services/svc-1');
		expect(
			buildClientServiceKeysUrl('svc-1', 'https://telemetry.test/api/admin'),
		).toBe('https://telemetry.test/api/admin/client-services/svc-1/keys');
		expect(
			buildClientServiceKeyRevokeUrl(
				'svc-1',
				'key-1',
				'https://telemetry.test/api/admin',
			),
		).toBe(
			'https://telemetry.test/api/admin/client-services/svc-1/keys/key-1/revoke',
		);
		expect(
			buildClientServiceLifecycleSubscriptionsUrl(
				'svc-1',
				'https://telemetry.test/api/admin',
			),
		).toBe(
			'https://telemetry.test/api/admin/client-services/svc-1/lifecycle-subscriptions',
		);
		expect(
			buildClientServicePoliciesUrl(
				'svc-1',
				'https://telemetry.test/api/admin',
			),
		).toBe('https://telemetry.test/api/admin/client-services/svc-1/policies');
		expect(
			buildClientServicePolicyUrl(
				'svc-1',
				'policy-1',
				'https://telemetry.test/api/admin',
			),
		).toBe(
			'https://telemetry.test/api/admin/client-services/svc-1/policies/policy-1',
		);
		expect(
			buildClientServiceLifecycleSubscriptionUrl(
				'svc-1',
				'sub-1',
				'https://telemetry.test/api/admin',
			),
		).toBe(
			'https://telemetry.test/api/admin/client-services/svc-1/lifecycle-subscriptions/sub-1',
		);
		expect(
			buildClientServiceImageResizePolicyUrl(
				'svc-1',
				'https://telemetry.test/api/admin',
			),
		).toBe(
			'https://telemetry.test/api/admin/client-services/svc-1/image-resize-policy',
		);
		expect(
			buildClientServiceImageResizeVariantsUrl(
				'svc-1',
				'https://telemetry.test/api/admin',
			),
		).toBe(
			'https://telemetry.test/api/admin/client-services/svc-1/image-resize-policy/variants',
		);
		expect(
			buildClientServiceImageResizeVariantUrl(
				'svc-1',
				'variant-1',
				'https://telemetry.test/api/admin',
			),
		).toBe(
			'https://telemetry.test/api/admin/client-services/svc-1/image-resize-policy/variants/variant-1',
		);
	});

	it('요청이 실패하면 사용자에게 표시할 에러를 반환한다', async () => {
		jest.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ message: 'fail' }), {
				status: 503,
				statusText: 'Service Unavailable',
			}),
		);

		await expect(
			fetchTelemetryJson('https://telemetry.test/api'),
		).rejects.toThrow(TelemetryApiError);
	});

	it('권위 자산 메타데이터를 받되 레거시 이미지 항목도 유지한다', async () => {
		process.env.TELEMETRY_API_BASE_URL = 'https://telemetry.test/api/admin';
		jest.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [
						{
							assetId: 'asset-1',
							assetStatus: 'Ready',
							imageKey: 'products/main/hero.png',
							path: 'products/main',
							name: 'hero.png',
							originalName: 'hero-original.png',
							bytes: 1024,
							checksum: 'sha256:abc',
							format: 'png',
							totalReads: 1,
							totalResizes: 0,
							totalCacheHits: 1,
							totalCacheMisses: 0,
							cacheHitRate: 1,
							totalFailures: 0,
							avgDurationMs: 1,
							p95DurationMs: 1,
							lastSeenAt: '2026-07-11T00:00:00.000Z',
						},
						{
							imageKey: 'legacy/image.png',
							path: 'legacy',
							name: 'image.png',
							totalReads: 0,
							totalResizes: 0,
							totalCacheHits: 0,
							totalCacheMisses: 0,
							cacheHitRate: null,
							totalFailures: 0,
							avgDurationMs: null,
							p95DurationMs: null,
							lastSeenAt: '2026-07-10T00:00:00.000Z',
						},
					],
				}),
				{ status: 200 },
			),
		);

		const result = await fetchImages();

		expect(result.items[0]).toMatchObject({
			assetId: 'asset-1',
			assetStatus: 'Ready',
			originalName: 'hero-original.png',
			bytes: 1024,
			checksum: 'sha256:abc',
		});
		expect(result.items[1].imageKey).toBe('legacy/image.png');
		expect(result.items[1].assetId).toBeUndefined();
		expect(result.items[1].assetStatus).toBeUndefined();
	});

	it('숫자 지표가 null이면 UI용 fallback 값을 만든다', () => {
		expect(toMetricDisplay(null, { suffix: 'ms' })).toBe('데이터 없음');
		expect(toMetricDisplay(12.345, { suffix: 'ms', fractionDigits: 1 })).toBe(
			'12.3ms',
		);
	});

	it('관리자 토큰은 서버 전용 env에서만 읽는다', () => {
		process.env.NEXT_PUBLIC_TELEMETRY_ADMIN_TOKEN = 'public-token';
		expect(getTelemetryAdminToken()).toBeUndefined();

		process.env.TELEMETRY_ADMIN_TOKEN = 'server-token';
		expect(getTelemetryAdminToken()).toBe('server-token');
	});

	it('개발 기본 API 포트는 telemetry-api 3100과 일치한다', () => {
		setEnv('NODE_ENV', 'test');
		delete process.env.TELEMETRY_API_BASE_URL;
		delete process.env.NEXT_PUBLIC_TELEMETRY_API_BASE_URL;

		expect(getTelemetryApiBaseUrl()).toBe('http://localhost:3100/api/admin');
	});

	it('production에서 API URL 누락과 fixture fallback을 fail-closed한다', () => {
		setEnv('NODE_ENV', 'production');
		delete process.env.TELEMETRY_API_BASE_URL;
		delete process.env.NEXT_PUBLIC_TELEMETRY_API_BASE_URL;
		process.env.ADMIN_WEB_ENABLE_FIXTURES = 'true';

		expect(() => getTelemetryApiBaseUrl()).toThrow('TELEMETRY_API_BASE_URL');
		expect(isAdminFixtureFallbackEnabled()).toBe(false);
	});
});

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function setEnv(name: string, value: string) {
	process.env[name] = value;
}
