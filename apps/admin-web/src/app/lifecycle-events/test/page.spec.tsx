import { renderToStaticMarkup } from 'react-dom/server';
import { LifecycleEventsPageContent } from '.././page';
import {
	clientServicesFixture,
	lifecycleEventListFixture,
} from '@/lib/fixtures';
import type { LifecycleEventListResponse } from '@/lib/telemetry-api';

const defaultProps = {
	services: clientServicesFixture,
	filters: { range: '24h', clientServiceId: 'svc-catalog' },
};

const renderLifecycleEvents = (data: LifecycleEventListResponse) =>
	renderToStaticMarkup(
		<LifecycleEventsPageContent data={data} {...defaultProps} />,
	);

describe('lifecycle 이벤트 페이지', () => {
	it('lifecycle 이벤트 목록을 발생 시각 내림차순으로 표시한다', () => {
		const html = renderLifecycleEvents({
			items: [...lifecycleEventListFixture.items].reverse(),
			nextCursor: lifecycleEventListFixture.nextCursor,
		});
		const failedIndex = html.indexOf('life-upload-failed-1');
		const completedIndex = html.indexOf('life-upload-completed-1');

		expect(failedIndex).toBeGreaterThan(-1);
		expect(completedIndex).toBeGreaterThan(-1);
		expect(failedIndex).toBeLessThan(completedIndex);
	});

	it('client service, event type, status, imageKey 필터를 표시한다', () => {
		const html = renderLifecycleEvents(lifecycleEventListFixture);

		expect(html).toContain('client service');
		expect(html).toContain('image.upload.completed');
		expect(html).toContain('image.upload.failed');
		expect(html).toContain('status');
		expect(html).toContain('imageKey');
		expect(html).toContain('Catalog API');
	});

	it('upload completed/failed 상세 정보를 details로 표시한다', () => {
		const html = renderLifecycleEvents(lifecycleEventListFixture);

		expect(html).toContain('상세 보기');
		expect(html).toContain('eventId');
		expect(html).toContain('receivedAt');
		expect(html).toContain('rawPayload');
		expect(html).toContain('BadRequestException');
		expect(html).toContain('지원하지 않는 이미지 형식입니다.');
		expect(html).toContain('trace-upload-900');
	});

	it('이벤트가 없으면 빈 상태를 표시한다', () => {
		const html = renderLifecycleEvents({ items: [] });

		expect(html).toContain('조건에 맞는 lifecycle 이벤트가 없습니다.');
	});

	it('다음 페이지 버튼은 nextCursor가 있을 때만 활성화된다', () => {
		const enabledHtml = renderLifecycleEvents(lifecycleEventListFixture);
		const disabledHtml = renderLifecycleEvents({
			items: lifecycleEventListFixture.items,
		});

		expect(enabledHtml).toContain('다음 페이지');
		expect(enabledHtml).not.toContain('disabled=""');
		expect(disabledHtml).toContain('disabled=""');
	});

	it('데이터 요청이 실패하면 fixture 사용 안내를 표시한다', () => {
		const html = renderToStaticMarkup(
			<LifecycleEventsPageContent
				data={lifecycleEventListFixture}
				{...defaultProps}
				errorMessage="telemetry-api lifecycle 이벤트를 불러오지 못해 fixture 데이터로 표시합니다."
			/>,
		);

		expect(html).toContain(
			'telemetry-api lifecycle 이벤트를 불러오지 못해 fixture 데이터로 표시합니다.',
		);
	});
});
