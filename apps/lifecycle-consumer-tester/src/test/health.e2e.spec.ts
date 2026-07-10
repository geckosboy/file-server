import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LifecycleConsumerStatusService } from '../consumer/lifecycle-consumer-status.service';
import { LifecycleEventStoreService } from '../consumer/lifecycle-event-store.service';
import { HealthController } from '../health.controller';

const createConsumerStatus = (overrides: Record<string, unknown> = {}) => ({
	enabled: true,
	connected: false,
	topic: 'file.image.lifecycle.v1',
	groupId: 'lifecycle-tester',
	...overrides,
});

describe('lifecycle consumer tester health e2e', () => {
	let app: INestApplication;
	let consumer = createConsumerStatus();
	const statusService = {
		getStatus: jest.fn(() => consumer),
	};
	const eventStore = {
		count: jest.fn(() => 7),
	};

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({
			controllers: [HealthController],
			providers: [
				{
					provide: LifecycleConsumerStatusService,
					useValue: statusService,
				},
				{
					provide: LifecycleEventStoreService,
					useValue: eventStore,
				},
			],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.init();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(() => {
		consumer = createConsumerStatus();
	});

	it('GET /health/live는 consumer 연결과 무관하게 200을 반환한다', async () => {
		consumer = createConsumerStatus({ enabled: true, connected: false });

		const response = await request(app.getHttpServer())
			.get('/health/live')
			.expect(200);

		expect(response.body).toMatchObject({
			ok: true,
			service: 'lifecycle-consumer-tester',
		});
		expect(response.body).not.toHaveProperty('consumer');
	});

	it.each([
		{ enabled: false, connected: false },
		{ enabled: true, connected: false },
	])(
		'GET /health/ready는 consumer 상태 $enabled/$connected에서 503을 반환한다',
		async ({ enabled, connected }) => {
			consumer = createConsumerStatus({ enabled, connected });

			const response = await request(app.getHttpServer())
				.get('/health/ready')
				.expect(503);

			expect(response.body).toMatchObject({
				ok: false,
				consumer: { enabled, connected },
				storedEvents: 7,
			});
		},
	);

	it('GET /health/ready는 consumer가 활성화되고 연결되면 200을 반환한다', async () => {
		consumer = createConsumerStatus({ enabled: true, connected: true });

		const response = await request(app.getHttpServer())
			.get('/health/ready')
			.expect(200);

		expect(response.body).toMatchObject({
			ok: true,
			consumer: { enabled: true, connected: true },
			storedEvents: 7,
		});
	});

	it('legacy GET /health는 기존 consumer/storedEvents 응답과 disabled 호환성을 유지한다', async () => {
		consumer = createConsumerStatus({ enabled: false, connected: false });

		const response = await request(app.getHttpServer())
			.get('/health')
			.expect(200);

		expect(response.body).toMatchObject({
			ok: true,
			consumer: { enabled: false, connected: false },
			storedEvents: 7,
		});
	});
});
