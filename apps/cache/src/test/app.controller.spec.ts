import { AppController } from '.././app.controller';

describe('앱 컨트롤러', () => {
	it('헬스 체크 요청에 OK를 반환한다', () => {
		expect(new AppController().healthCheck()).toBe('OK');
	});
});
