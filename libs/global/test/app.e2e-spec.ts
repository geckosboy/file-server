import { parseOriginList } from '../src';

describe('global utilities', () => {
	it('exports parseOriginList', () => {
		expect(parseOriginList('http://localhost:3000')).toEqual([
			'http://localhost:3000',
		]);
	});
});
