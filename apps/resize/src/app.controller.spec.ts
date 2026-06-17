import { AppController } from './app.controller';

describe('AppController', () => {
	it('returns health-check OK', () => {
		expect(new AppController().healthCheck()).toBe('OK');
	});
});
