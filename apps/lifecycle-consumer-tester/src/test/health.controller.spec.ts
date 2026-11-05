import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
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

describe('HealthController', () => {
	const statusService = {
		getStatus: jest.fn(),
	};
	const eventStore = {
		count: jest.fn(),
	};
	const controller = new HealthController(
		statusService as unknown as LifecycleConsumerStatusService,
		eventStore as unknown as LifecycleEventStoreService,
	);

	beforeEach(() => {
		jest.clearAllMocks();
		statusService.getStatus.mockReturnValue(createConsumerStatus());
		eventStore.count.mockReturnValue(3);
	});

	it('liveness는 Kafka 상태를 조회하지 않고 process 생존만 반환한다', () => {
		expect(controller.getLiveness()).toMatchObject({
			ok: true,
			service: 'lifecycle-consumer-tester',
			checkedAt: expect.any(String),
		});
		expect(statusService.getStatus).not.toHaveBeenCalled();
		expect(eventStore.count).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: 'consumer가 비활성',
			consumer: createConsumerStatus({ enabled: false, connected: false }),
		},
		{
			name: 'consumer가 연결되지 않음',
			consumer: createConsumerStatus({ enabled: true, connected: false }),
		},
	])('$name 상태면 readiness를 503으로 설정한다', ({ consumer }) => {
		statusService.getStatus.mockReturnValue(consumer);
		const response = {
			status: jest.fn().mockReturnThis(),
		} as unknown as Response;

		expect(controller.getReadiness(response)).toMatchObject({
			ok: false,
			consumer,
			storedEvents: 3,
		});
		expect(response.status).toHaveBeenCalledWith(
			HttpStatus.SERVICE_UNAVAILABLE,
		);
	});

	it('consumer가 활성화되고 연결되면 readiness를 200으로 설정한다', () => {
		const consumer = createConsumerStatus({ enabled: true, connected: true });
		statusService.getStatus.mockReturnValue(consumer);
		const response = {
			status: jest.fn().mockReturnThis(),
		} as unknown as Response;

		expect(controller.getReadiness(response)).toMatchObject({
			ok: true,
			consumer,
			storedEvents: 3,
		});
		expect(response.status).toHaveBeenCalledWith(HttpStatus.OK);
	});

	it('legacy health는 consumer와 storedEvents를 보존하고 disabled를 허용한다', () => {
		const consumer = createConsumerStatus({ enabled: false, connected: false });
		statusService.getStatus.mockReturnValue(consumer);

		expect(controller.getHealth()).toMatchObject({
			ok: true,
			consumer,
			storedEvents: 3,
		});
	});
});
