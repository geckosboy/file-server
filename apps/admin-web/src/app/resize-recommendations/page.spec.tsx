import { renderToStaticMarkup } from 'react-dom/server';
import { ResizeRecommendationsPageContent } from './page';
import {
	clientServicesFixture,
	imageResizeRecommendationsFixture,
} from '@/lib/fixtures';

const defaultProps = {
	data: imageResizeRecommendationsFixture,
	services: clientServicesFixture,
	filters: {
		range: '24h',
		clientServiceId: 'svc-catalog',
		minRequests: 3,
	},
};

const renderRecommendations = () =>
	renderToStaticMarkup(<ResizeRecommendationsPageContent {...defaultProps} />);

describe('리사이징 정책 추천 페이지', () => {
	it('서비스별 추천 사이즈와 상태를 표시한다', () => {
		const html = renderRecommendations();

		expect(html).toContain('리사이징 정책 추천');
		expect(html).toContain('Catalog API');
		expect(html).toContain('400x400');
		expect(html).toContain('webp');
		expect(html).toContain('pre-generate 추천');
	});

	it('추천을 정책에 반영하는 버튼을 표시한다', () => {
		const html = renderRecommendations();

		expect(html).toContain('정책에 반영');
		expect(html).toContain('이미 반영됨');
		expect(html).toContain('예상 절감');
	});

	it('필터와 fallback 안내를 표시한다', () => {
		const html = renderToStaticMarkup(
			<ResizeRecommendationsPageContent
				{...defaultProps}
				errorMessage="텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다."
			/>,
		);

		expect(html).toContain('client service');
		expect(html).toContain('추천 임계값');
		expect(html).toContain(
			'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		);
	});
});
