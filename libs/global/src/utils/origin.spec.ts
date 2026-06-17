import { parseOriginList } from './origin';

describe('parseOriginList', () => {
	it('parses comma-separated origins as exact strings', () => {
		expect(
			parseOriginList('http://localhost:3000, https://example.com '),
		).toEqual(['http://localhost:3000', 'https://example.com']);
	});
});
