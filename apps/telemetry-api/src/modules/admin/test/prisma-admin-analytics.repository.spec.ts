import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '@file/database';
import { PrismaAdminAnalyticsRepository } from '.././prisma-admin-analytics.repository';

type PrismaMock = {
	$queryRaw: jest.Mock;
};

const range = {
	from: '2026-07-01T00:00:00.000Z',
	to: '2026-07-01T02:59:59.999Z',
};

describe('PostgreSQL 관리자 analytics repository', () => {
	let prisma: PrismaMock;
	let repository: PrismaAdminAnalyticsRepository;

	beforeEach(() => {
		prisma = { $queryRaw: jest.fn() };
		repository = new PrismaAdminAnalyticsRepository(
			prisma as unknown as PrismaService,
		);
	});

	it('summary를 DB aggregate 결과에서 기존 응답 shape으로 변환한다', async () => {
		prisma.$queryRaw.mockResolvedValue([
			{
				totalEvents: 5n,
				totalReads: 3n,
				totalUploads: 1n,
				totalResizes: 1n,
				cacheHits: 1n,
				cacheMisses: 1n,
				failures: 1n,
				avgDurationMs: '30',
				p95DurationMs: 50,
				totalInputBytes: 260n,
				totalOutputBytes: 120n,
			},
		]);

		await expect(repository.getSummary(range)).resolves.toEqual({
			range,
			totalEvents: 5,
			totalReads: 3,
			totalUploads: 1,
			totalResizes: 1,
			cacheHitRate: 0.5,
			cacheMissRate: 0.5,
			failureRate: 0.2,
			avgDurationMs: 30,
			p95DurationMs: 50,
			totalInputBytes: 260,
			totalOutputBytes: 120,
		});
		expect(sqlText(prisma)).toContain('percentile_disc(0.95)');
	});

	it('모든 사용자 filter 값은 SQL 문자열이 아니라 bind value로 전달한다', async () => {
		const malicious = "cache' OR 1=1 --";
		prisma.$queryRaw.mockResolvedValue([emptySummaryRow()]);

		await repository.getSummary({
			...range,
			eventType: malicious,
			sourceApp: malicious,
			status: malicious,
			clientServiceId: malicious,
			clientServiceSlug: malicious,
			path: malicious,
			name: malicious,
			imageKey: malicious,
			requestId: malicious,
		});

		const sql = prisma.$queryRaw.mock.calls[0][0] as {
			strings: string[];
			values: unknown[];
		};
		expect(sql.strings.join('?')).not.toContain(malicious);
		expect(sql.values.filter((value) => value === malicious)).toHaveLength(9);
	});

	it('timeseries는 빈 bucket을 포함한 DB 결과를 그대로 정규화한다', async () => {
		prisma.$queryRaw.mockResolvedValue([
			{
				bucketStart: new Date('2026-07-01T00:00:00.000Z'),
				totalEvents: 2n,
				cacheHits: 1n,
				cacheMisses: 1n,
				resizeCompleted: 0n,
				uploadCompleted: 0n,
				failures: 0n,
				avgDurationMs: '15',
				p95DurationMs: '20',
			},
			{
				bucketStart: '2026-07-01T01:00:00.000Z',
				totalEvents: 0n,
				cacheHits: 0n,
				cacheMisses: 0n,
				resizeCompleted: 0n,
				uploadCompleted: 0n,
				failures: 0n,
				avgDurationMs: null,
				p95DurationMs: null,
			},
		]);

		const response = await repository.getTimeseries({
			...range,
			interval: 'hour',
		});

		expect(response).toEqual({
			interval: 'hour',
			points: [
				{
					bucketStart: '2026-07-01T00:00:00.000Z',
					totalEvents: 2,
					cacheHits: 1,
					cacheMisses: 1,
					cacheHitRate: 0.5,
					resizeCompleted: 0,
					uploadCompleted: 0,
					failures: 0,
					avgDurationMs: 15,
					p95DurationMs: 20,
				},
				{
					bucketStart: '2026-07-01T01:00:00.000Z',
					totalEvents: 0,
					cacheHits: 0,
					cacheMisses: 0,
					cacheHitRate: null,
					resizeCompleted: 0,
					uploadCompleted: 0,
					failures: 0,
					avgDurationMs: null,
					p95DurationMs: null,
				},
			],
		});
		expect(sqlText(prisma)).toContain('generate_series');
		expect(sqlText(prisma)).toContain('date_trunc');
	});

	it('top image aggregate를 DB에서 bounded 정렬하고 응답 shape으로 변환한다', async () => {
		prisma.$queryRaw.mockResolvedValue([topImageRow()]);

		await expect(
			repository.listTopImages({
				...range,
				q: 'sample',
				sort: 'reads',
				order: 'desc',
				limit: 10,
			}),
		).resolves.toEqual({
			items: [topImageItem()],
		});
		expect(sqlText(prisma)).toContain('FROM "image_assets"');
		expect(sqlText(prisma)).toContain(
			'"status" <> \'Deleted\'::"ImageAssetState"',
		);
		expect(sqlText(prisma)).toContain('FROM "telemetry_events"');
		expect(sqlText(prisma)).toContain('LIMIT ?');
	});

	it('authoritative image 목록은 owner를 직접 제한하고 기간 내 usage가 있는 asset만 포함한다', async () => {
		const clientServiceId = "service-a' OR 1=1 --";
		const clientServiceSlug = "catalog-api' OR 1=1 --";
		prisma.$queryRaw.mockResolvedValue([
			topImageRow({
				assetId: 'asset-a',
				assetStatus: 'Ready',
			}),
		]);

		await expect(
			repository.listTopImages({
				...range,
				clientServiceId,
				clientServiceSlug,
				limit: 10,
			}),
		).resolves.toEqual({
			items: [
				{
					...topImageItem(),
					assetId: 'asset-a',
					assetStatus: 'Ready',
				},
			],
		});

		const sql = lastSql(prisma);
		const text = sql.strings.join('?');
		expect(text).toContain('FROM "image_assets" AS "asset"');
		expect(text).toContain('JOIN "client_services" AS "owner"');
		expect(text).toContain('"asset"."client_service_id" = ?');
		expect(text).toContain('"owner"."slug" = ?');
		expect(text).toContain('FROM "filtered_events" AS "membership_event"');
		expect(text).toContain(
			'"membership_event"."client_service_id" = "asset"."client_service_id"',
		);
		expect(text).not.toContain(clientServiceId);
		expect(text).not.toContain(clientServiceSlug);
		expect(
			sql.values.filter((value) => value === clientServiceId),
		).toHaveLength(2);
		expect(
			sql.values.filter((value) => value === clientServiceSlug),
		).toHaveLength(2);
	});

	it('top image page는 sort-aware opaque cursor와 legacy offset을 모두 지원한다', async () => {
		prisma.$queryRaw.mockResolvedValue([
			topImageRow(),
			topImageRow({
				imageKey: 'products/image/other.png',
				name: 'other.png',
				totalReads: 2n,
			}),
		]);

		const firstPage = await repository.listTopImages({
			sort: 'reads',
			order: 'desc',
			limit: 1,
		});
		expect(firstPage.items).toEqual([topImageItem()]);
		expect(firstPage.nextCursor).toMatch(/^img\.v1\./);
		expect(sqlText(prisma)).toContain('LIMIT ?');

		prisma.$queryRaw.mockResolvedValue([
			topImageRow(),
			topImageRow({ imageKey: 'products/image/other.png' }),
		]);
		const legacyPage = await repository.listTopImages({
			cursor: '10',
			limit: 1,
		});
		expect(legacyPage.nextCursor).toMatch(/^img\.v1\./);
		expect(sqlText(prisma)).toContain('OFFSET ?');
	});

	it('image detail과 variants를 전체 event materialization 없이 DB aggregate한다', async () => {
		prisma.$queryRaw
			.mockResolvedValueOnce([topImageRow()])
			.mockResolvedValueOnce([
				{
					variantKey: 'products/image/sample.png:400x400:webp',
					imageKey: 'products/image/sample.png',
					width: 400,
					height: 400,
					format: 'webp',
					outputBytes: 900,
					resizeCount: 3n,
					avgDurationMs: '20',
					p95DurationMs: '30',
					lastResizedAt: '2026-07-01T03:02:00.000Z',
				},
			]);

		await expect(
			repository.getImage('products/image/sample.png'),
		).resolves.toEqual(topImageItem());
		await expect(
			repository.listVariants('products/image/sample.png'),
		).resolves.toEqual([
			{
				variantKey: 'products/image/sample.png:400x400:webp',
				imageKey: 'products/image/sample.png',
				width: 400,
				height: 400,
				format: 'webp',
				outputBytes: 900,
				resizeCount: 3,
				avgDurationMs: 20,
				p95DurationMs: 30,
				lastResizedAt: '2026-07-01T03:02:00.000Z',
			},
		]);
		expect(sqlText(prisma)).toContain('LIMIT ?');
	});

	it('resize recommendation은 on-demand 조건과 threshold를 DB query에 적용한다', async () => {
		prisma.$queryRaw.mockResolvedValue([
			{
				clientServiceId: 'service-a',
				clientServiceSlug: 'catalog-api',
				width: 400,
				height: 400,
				format: 'webp',
				requestCount: 3n,
				imageCount: 2n,
				avgDurationMs: '20',
				p95DurationMs: '30',
				estimatedSavedResizeMs: '60',
				totalInputBytes: 3000n,
				totalOutputBytes: 900n,
				lastRequestedAt: '2026-07-01T03:02:00.000Z',
				sampleImageKeys: [
					'products/image/a.png',
					'products/image/a.png',
					'products/image/b.png',
				],
			},
		]);

		const response = await repository.listResizeRecommendations({
			...range,
			clientServiceSlug: 'catalog-api',
			minRequests: 3,
			limit: 10,
		});

		expect(response).toEqual({
			threshold: { minRequests: 3 },
			items: [
				{
					recommendationKey: 'service-a:catalog-api:400:400:webp',
					clientServiceId: 'service-a',
					clientServiceSlug: 'catalog-api',
					width: 400,
					height: 400,
					format: 'webp',
					requestCount: 3,
					imageCount: 2,
					avgDurationMs: 20,
					p95DurationMs: 30,
					estimatedSavedResizeMs: 60,
					totalInputBytes: 3000,
					totalOutputBytes: 900,
					lastRequestedAt: '2026-07-01T03:02:00.000Z',
					sampleImageKeys: ['products/image/a.png', 'products/image/b.png'],
					recommended: true,
				},
			],
		});
		expect(sqlText(prisma)).toContain('"cache_key" IS NULL');
		expect(sqlText(prisma)).toContain('COUNT(DISTINCT "image_key")');
	});

	it.each([
		() => repository.getSummary({ from: 'not-a-date' }),
		() =>
			repository.getTimeseries({
				...range,
				interval: 'week' as 'hour',
			}),
		() => repository.listTopImages({ limit: 101 }),
		() =>
			repository.getTimeseries({
				from: '2026-01-01T00:00:00.000Z',
				to: '2026-07-01T00:00:00.000Z',
				interval: 'minute',
			}),
		() => repository.listResizeRecommendations({ minRequests: 0 }),
	])('잘못된 범위/interval/bound를 query 실행 전에 거부한다', async (call) => {
		await expect(call()).rejects.toBeInstanceOf(BadRequestException);
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});
});

function sqlText(prisma: PrismaMock): string {
	const sql = prisma.$queryRaw.mock.calls.at(-1)?.[0] as
		{ strings: string[] } | undefined;
	return sql?.strings.join('?') ?? '';
}

function lastSql(prisma: PrismaMock): { strings: string[]; values: unknown[] } {
	return prisma.$queryRaw.mock.calls.at(-1)?.[0] as {
		strings: string[];
		values: unknown[];
	};
}

function emptySummaryRow() {
	return {
		totalEvents: 0n,
		totalReads: 0n,
		totalUploads: 0n,
		totalResizes: 0n,
		cacheHits: 0n,
		cacheMisses: 0n,
		failures: 0n,
		avgDurationMs: null,
		p95DurationMs: null,
		totalInputBytes: 0n,
		totalOutputBytes: 0n,
	};
}

function topImageRow(overrides: Record<string, unknown> = {}) {
	return {
		imageKey: 'products/image/sample.png',
		imageId: 100,
		path: 'products/image',
		name: 'sample.png',
		format: 'png',
		totalReads: 3n,
		totalResizes: 1n,
		totalCacheHits: 1n,
		totalCacheMisses: 1n,
		totalFailures: 1n,
		avgDurationMs: '30',
		p95DurationMs: '50',
		lastSeenAt: new Date('2026-07-01T02:00:00.000Z'),
		...overrides,
	};
}

function topImageItem() {
	return {
		imageKey: 'products/image/sample.png',
		imageId: 100,
		path: 'products/image',
		name: 'sample.png',
		format: 'png',
		totalReads: 3,
		totalResizes: 1,
		totalCacheHits: 1,
		totalCacheMisses: 1,
		cacheHitRate: 0.5,
		totalFailures: 1,
		avgDurationMs: 30,
		p95DurationMs: 50,
		lastSeenAt: '2026-07-01T02:00:00.000Z',
	};
}
