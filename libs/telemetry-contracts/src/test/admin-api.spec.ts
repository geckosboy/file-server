import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
	DashboardSummaryQueryDto,
	EventsListQueryDto,
	ImageListSortField,
	ImagesListQueryDto,
} from '.././admin-api';
import {
	ImageTelemetryEventType,
	ImageTelemetrySourceApp,
	ImageTelemetryStatus,
} from '.././events';

describe('텔레메트리 관리자 API 계약 DTO', () => {
	it('대시보드 기간 쿼리를 ISO 날짜로 검증한다', async () => {
		const dto = plainToInstance(DashboardSummaryQueryDto, {
			from: '2026-01-01T00:00:00.000Z',
			to: '2026-01-02T00:00:00.000Z',
		});

		await expect(validate(dto)).resolves.toEqual([]);
	});

	it('대시보드 기간 쿼리의 잘못된 날짜를 거부한다', async () => {
		const dto = plainToInstance(DashboardSummaryQueryDto, {
			from: 'not-date',
			to: '2026-01-02T00:00:00.000Z',
		});

		await expect(validate(dto)).resolves.toHaveLength(1);
	});

	it('이벤트 목록 limit은 최대 100으로 제한한다', async () => {
		const validDto = plainToInstance(EventsListQueryDto, {
			eventType: ImageTelemetryEventType.CacheMiss,
			sourceApp: ImageTelemetrySourceApp.Cache,
			status: ImageTelemetryStatus.Success,
			limit: '100',
		});
		const invalidDto = plainToInstance(EventsListQueryDto, {
			limit: '101',
		});

		await expect(validate(validDto)).resolves.toEqual([]);
		expect(validDto.limit).toBe(100);
		await expect(validate(invalidDto)).resolves.toHaveLength(1);
	});

	it('이미지 목록 정렬 필드는 허용된 값만 받는다', async () => {
		const validDto = plainToInstance(ImagesListQueryDto, {
			sort: ImageListSortField.CacheMisses,
			order: 'desc',
		});
		const invalidDto = plainToInstance(ImagesListQueryDto, {
			sort: 'createdAt',
		});

		await expect(validate(validDto)).resolves.toEqual([]);
		await expect(validate(invalidDto)).resolves.toHaveLength(1);
	});

	it('커서가 없으면 첫 페이지 요청으로 처리한다', async () => {
		const dto = plainToInstance(EventsListQueryDto, {
			from: '2026-01-01T00:00:00.000Z',
			to: '2026-01-02T00:00:00.000Z',
		});

		await expect(validate(dto)).resolves.toEqual([]);
		expect(dto.cursor).toBeUndefined();
	});
});
