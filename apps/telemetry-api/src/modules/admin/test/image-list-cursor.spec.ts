import { BadRequestException } from '@nestjs/common';
import {
	encodeImageListCursor,
	parseImageListCursor,
} from '.././image-list-cursor';

describe('image aggregate cursor', () => {
	it('sort key, direction, tie-break imageKey를 opaque envelope로 round-trip한다', () => {
		const encoded = encodeImageListCursor({
			sort: 'reads',
			order: 'desc',
			sortValue: 42,
			imageKey: 'catalog/image/sample.jpg',
		});

		expect(encoded).toMatch(/^img\.v1\.[A-Za-z0-9_-]+$/);
		expect(parseImageListCursor(encoded, 'reads', 'desc')).toEqual({
			cursor: {
				sort: 'reads',
				order: 'desc',
				sortValue: 42,
				imageKey: 'catalog/image/sample.jpg',
			},
		});
	});

	it('legacy numeric cursor는 transition offset으로 유지한다', () => {
		expect(parseImageListCursor('100', 'lastSeenAt', 'desc')).toEqual({
			offset: 100,
		});
	});

	it('다른 sort/order query 또는 변조된 cursor는 거부한다', () => {
		const encoded = encodeImageListCursor({
			sort: 'lastSeenAt',
			order: 'desc',
			sortValue: '2026-07-01T00:00:00.000Z',
			imageKey: 'sample.jpg',
		});

		expect(() => parseImageListCursor(encoded, 'reads', 'desc')).toThrow(
			BadRequestException,
		);
		expect(() =>
			parseImageListCursor('img.v1.not-json', 'reads', 'desc'),
		).toThrow(BadRequestException);
	});
});
