import { renderToStaticMarkup } from 'react-dom/server';
import { ServicesPageContent } from '.././page';
import { clientServicesFixture } from '@/lib/fixtures';

const renderServices = () =>
	renderToStaticMarkup(
		<ServicesPageContent services={clientServicesFixture} />,
	);

describe('서비스 레지스트리 페이지', () => {
	it('서비스 등록 폼과 등록된 서비스를 표시한다', () => {
		const html = renderServices();

		expect(html).toContain('서비스 레지스트리');
		expect(html).toContain('서비스 등록');
		expect(html).toContain('Catalog API');
		expect(html).toContain('catalog-api');
	});

	it('API key 발급/폐기 관리 영역을 표시한다', () => {
		const html = renderServices();

		expect(html).toContain('API key 발급');
		expect(html).toContain('API keys');
		expect(html).toContain('cat123');
		expect(html).toContain('폐기');
	});

	it('lifecycle subscription 등록/수정 관리 영역을 표시한다', () => {
		const html = renderServices();

		expect(html).toContain('lifecycle subscription 등록');
		expect(html).toContain('Lifecycle subscriptions');
		expect(html).toContain('image.upload.completed');
		expect(html).toContain('image.upload.failed');
		expect(html).toContain('catalog-image-consumer');
		expect(html).toContain('활성 subscription');
	});

	it('이미지 리사이징 정책 관리 영역을 표시한다', () => {
		const html = renderServices();

		expect(html).toContain('이미지 리사이징 정책');
		expect(html).toContain('ON_DEMAND');
		expect(html).toContain('PRE_GENERATE');
		expect(html).toContain('400x400');
		expect(html).toContain('webp');
		expect(html).toContain('사전 생성 사이즈 추가');
	});

	it('데이터 요청 실패 안내를 표시한다', () => {
		const html = renderToStaticMarkup(
			<ServicesPageContent
				errorMessage="텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다."
				services={clientServicesFixture}
			/>,
		);

		expect(html).toContain(
			'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		);
	});
});
