import {
	TelemetryApiError,
	buildDashboardSummaryUrl,
	buildEventsUrl,
	buildImagesUrl,
	fetchTelemetryJson,
	toMetricDisplay,
} from './telemetry-api';

describe('텔레메트리 API 클라이언트', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('대시보드 요약 API URL에 기간 쿼리를 포함한다', () => {
		const url = new URL(
			buildDashboardSummaryUrl(
				{
					from: '2026-07-01T00:00:00.000Z',
					to: '2026-07-02T00:00:00.000Z',
				},
				'https://telemetry.test/api/admin',
			),
		);

		expect(url.pathname).toBe('/api/admin/dashboard/summary');
		expect(url.searchParams.get('from')).toBe('2026-07-01T00:00:00.000Z');
		expect(url.searchParams.get('to')).toBe('2026-07-02T00:00:00.000Z');
	});

	it('이벤트 목록 API URL에 필터와 cursor를 포함한다', () => {
		const url = new URL(
			buildEventsUrl(
				{
					eventType: 'image.cache.miss',
					sourceApp: 'cache',
					status: 'success',
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
		expect(url.searchParams.get('cursor')).toBe('cursor-1');
		expect(url.searchParams.get('limit')).toBe('50');
	});

	it('이미지 목록 API URL에 검색어와 정렬을 포함한다', () => {
		const url = new URL(
			buildImagesUrl(
				{
					q: 'hero',
					sort: 'cacheMisses',
					order: 'desc',
				},
				'https://telemetry.test/api/admin',
			),
		);

		expect(url.pathname).toBe('/api/admin/images');
		expect(url.searchParams.get('q')).toBe('hero');
		expect(url.searchParams.get('sort')).toBe('cacheMisses');
		expect(url.searchParams.get('order')).toBe('desc');
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

	it('숫자 지표가 null이면 UI용 fallback 값을 만든다', () => {
		expect(toMetricDisplay(null, { suffix: 'ms' })).toBe('데이터 없음');
		expect(toMetricDisplay(12.345, { suffix: 'ms', fractionDigits: 1 })).toBe(
			'12.3ms',
		);
	});
});
