import { AppController } from '.././app.controller';
import { AppHealthService } from '../app-health.service';

describe('앱 컨트롤러', () => {
	it('준비 상태이면 live와 호환 health-check를 반환한다', async () => {
		const health = {
			getLive: jest.fn().mockReturnValue({ ok: true, service: 'cache' }),
			getReady: jest.fn().mockResolvedValue({ ok: true, service: 'cache' }),
		};
		const controller = new AppController(health as unknown as AppHealthService);

		expect(controller.healthLive()).toEqual({ ok: true, service: 'cache' });
		await expect(controller.healthCheck()).resolves.toBe('OK');
	});

	it('의존성 장애이면 readiness와 호환 health-check가 503이다', async () => {
		const controller = new AppController({
			getReady: jest.fn().mockResolvedValue({ ok: false, service: 'cache' }),
		} as unknown as AppHealthService);

		await expect(controller.healthReady()).rejects.toMatchObject({
			status: 503,
		});
		await expect(controller.healthCheck()).rejects.toMatchObject({
			status: 503,
		});
	});
});
