import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardPageContent } from './page';
import { clientServicesFixture, dashboardDataFixture } from '@/lib/fixtures';
import type { DashboardData } from '@/lib/telemetry-api';

const defaultProps = {
	services: clientServicesFixture,
	filters: { range: '24h', clientServiceId: 'svc-catalog' },
};

const renderDashboard = (data: DashboardData) =>
	renderToStaticMarkup(<DashboardPageContent data={data} {...defaultProps} />);

describe('관리자 대시보드 페이지', () => {
	it('대시보드가 KPI 카드를 표시한다', () => {
		const html = renderDashboard(dashboardDataFixture);

		expect(html).toContain('총 이벤트 수');
		expect(html).toContain('캐시 hit율');
		expect(html).toContain('p95 처리 시간');
	});

	it('캐시 hit율이 없으면 빈 상태 문구를 표시한다', () => {
		const html = renderDashboard({
			...dashboardDataFixture,
			summary: {
				...dashboardDataFixture.summary,
				cacheHitRate: null,
				cacheMissRate: null,
			},
		});

		expect(html).toContain('데이터 없음');
		expect(html).toContain('캐시 이벤트 데이터 없음');
	});

	it('실패율이 임계값을 넘으면 위험 상태로 표시한다', () => {
		const html = renderDashboard({
			...dashboardDataFixture,
			summary: {
				...dashboardDataFixture.summary,
				failureRate: 0.25,
			},
		});

		expect(html).toContain('위험: 실패율 임계값 초과');
		expect(html).toContain('metric-card-danger');
	});

	it('기간과 client service 필터 및 주요 차트를 표시한다', () => {
		const html = renderDashboard(dashboardDataFixture);

		expect(html).toContain('기간:');
		expect(html).toContain('client service');
		expect(html).toContain('Catalog API');
		expect(html).toContain('캐시 hit/miss 추이');
		expect(html).toContain('resize/upload 이벤트 추이');
	});

	it('데이터 요청이 실패하면 fixture 사용 안내를 표시한다', () => {
		const html = renderToStaticMarkup(
			<DashboardPageContent
				data={dashboardDataFixture}
				{...defaultProps}
				errorMessage="텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다."
			/>,
		);

		expect(html).toContain(
			'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		);
	});
});
