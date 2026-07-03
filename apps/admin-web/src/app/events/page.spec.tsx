import { renderToStaticMarkup } from 'react-dom/server';
import { EventsPageContent } from './page';
import { clientServicesFixture, eventListFixture } from '@/lib/fixtures';
import type { EventListResponse } from '@/lib/telemetry-api';

const defaultProps = {
	services: clientServicesFixture,
	filters: { range: '24h', clientServiceId: 'svc-catalog' },
};

const renderEvents = (data: EventListResponse) =>
	renderToStaticMarkup(<EventsPageContent data={data} {...defaultProps} />);

describe('이벤트 로그 페이지', () => {
	it('이벤트 목록을 발생 시각 내림차순으로 표시한다', () => {
		const html = renderEvents({
			items: [...eventListFixture.items].reverse(),
			nextCursor: eventListFixture.nextCursor,
		});
		const failedIndex = html.indexOf('image.resize.failed');
		const uploadIndex = html.indexOf('image.upload.completed');

		expect(failedIndex).toBeGreaterThan(-1);
		expect(uploadIndex).toBeGreaterThan(-1);
		expect(failedIndex).toBeLessThan(uploadIndex);
	});

	it('이벤트 타입과 client service 필터를 표시한다', () => {
		const html = renderEvents(eventListFixture);

		expect(html).toContain('이벤트 타입');
		expect(html).toContain('client service');
		expect(html).toContain('image.cache.miss');
		expect(html).toContain('Catalog API');
	});

	it('실패 이벤트 행에는 서비스와 에러 메시지를 표시한다', () => {
		const html = renderEvents(eventListFixture);

		expect(html).toContain('catalog-api');
		expect(html).toContain('SHARP_INPUT_INVALID');
		expect(html).toContain('이미지 디코딩에 실패했습니다.');
	});

	it('이벤트가 없으면 빈 상태를 표시한다', () => {
		const html = renderEvents({ items: [] });

		expect(html).toContain('조건에 맞는 이벤트가 없습니다.');
	});

	it('다음 페이지 버튼은 nextCursor가 있을 때만 활성화된다', () => {
		const enabledHtml = renderEvents(eventListFixture);
		const disabledHtml = renderEvents({ items: eventListFixture.items });

		expect(enabledHtml).toContain('다음 페이지');
		expect(enabledHtml).not.toContain('disabled=""');
		expect(disabledHtml).toContain('disabled=""');
	});

	it('데이터 요청이 실패하면 fixture 사용 안내를 표시한다', () => {
		const html = renderToStaticMarkup(
			<EventsPageContent
				data={eventListFixture}
				{...defaultProps}
				errorMessage="텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다."
			/>,
		);

		expect(html).toContain(
			'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		);
	});
});
