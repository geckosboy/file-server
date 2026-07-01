import { parseOriginList } from '../src';

describe('전역 유틸리티', () => {
	it('parseOriginList를 내보낸다', () => {
		expect(parseOriginList('http://localhost:3000')).toEqual([
			'http://localhost:3000',
		]);
	});
});
