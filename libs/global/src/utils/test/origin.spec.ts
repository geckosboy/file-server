import { parseOriginList } from '.././origin';

describe('오리진 목록 파서', () => {
	it('쉼표로 구분된 오리진을 정확한 문자열 목록으로 파싱한다', () => {
		expect(
			parseOriginList('http://localhost:3000, https://example.com '),
		).toEqual(['http://localhost:3000', 'https://example.com']);
	});
});
