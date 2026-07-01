import { renderToStaticMarkup } from 'react-dom/server';
import { ImagesPageContent } from './page';
import { imageListFixture } from '@/lib/fixtures';
import type { ImageListResponse } from '@/lib/telemetry-api';

const renderImages = (data: ImageListResponse) =>
	renderToStaticMarkup(<ImagesPageContent data={data} />);

describe('이미지 집계 페이지', () => {
	it('이미지 목록에 path와 name을 표시한다', () => {
		const html = renderImages(imageListFixture);

		expect(html).toContain('products/main');
		expect(html).toContain('hero.png');
	});

	it('캐시 hit율을 퍼센트로 표시한다', () => {
		const html = renderImages(imageListFixture);

		expect(html).toContain('81.8%');
	});

	it('요청 수 기준 정렬을 선택할 수 있다', () => {
		const html = renderImages({
			items: [...imageListFixture.items].reverse(),
		});
		const heroIndex = html.indexOf('products/main/hero.png');
		const cardIndex = html.indexOf('products/thumb/card.jpg');

		expect(html).toContain('요청 수');
		expect(heroIndex).toBeLessThan(cardIndex);
	});

	it('검색어를 입력할 수 있는 필터를 표시한다', () => {
		const html = renderImages(imageListFixture);

		expect(html).toContain('검색어');
		expect(html).toContain('path, name, imageKey');
	});

	it('이미지가 없으면 빈 상태를 표시한다', () => {
		const html = renderImages({ items: [] });

		expect(html).toContain('조건에 맞는 이미지가 없습니다.');
	});

	it('데이터 요청이 실패하면 fixture 사용 안내를 표시한다', () => {
		const html = renderToStaticMarkup(
			<ImagesPageContent
				data={imageListFixture}
				errorMessage="텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다."
			/>,
		);

		expect(html).toContain(
			'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		);
	});
});
