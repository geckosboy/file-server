import { AdminAnalyticsRepository } from '../admin-analytics.types';
import { AdminQueryService } from '../admin-query.service';
import { LifecycleRepository } from '../../lifecycle/lifecycle.repository';
import { TelemetryRepository } from '../../telemetry/telemetry.repository';

describe('AdminQueryService database analytics seam', () => {
	it('delegates every aggregate/image management path without all-row reads', async () => {
		const telemetryRepository = {
			listEvents: jest.fn(() => {
				throw new Error('unbounded telemetry read');
			}),
			listAssets: jest.fn(() => {
				throw new Error('unbounded asset projection');
			}),
			listVariants: jest.fn(() => {
				throw new Error('unbounded variant projection');
			}),
		} as unknown as TelemetryRepository;
		const lifecycleRepository = {} as LifecycleRepository;
		const summary = {
			range: {
				from: '2026-07-01T00:00:00.000Z',
				to: '2026-07-02T00:00:00.000Z',
			},
			totalEvents: 1,
			totalReads: 1,
			totalUploads: 0,
			totalResizes: 0,
			cacheHitRate: 1,
			cacheMissRate: 0,
			failureRate: 0,
			avgDurationMs: 5,
			p95DurationMs: 5,
			totalInputBytes: 0,
			totalOutputBytes: 0,
		};
		const image = {
			imageKey: 'products/image/sample.png',
			path: 'products/image',
			name: 'sample.png',
			totalReads: 1,
			totalResizes: 0,
			totalCacheHits: 1,
			totalCacheMisses: 0,
			cacheHitRate: 1,
			totalFailures: 0,
			avgDurationMs: 5,
			p95DurationMs: 5,
			lastSeenAt: '2026-07-01T00:00:00.000Z',
		};
		const variants = [
			{
				variantKey: 'products/image/sample.png:120x80:webp',
				imageKey: 'products/image/sample.png',
				width: 120,
				height: 80,
				format: 'webp' as const,
				resizeCount: 1,
				avgDurationMs: 5,
				p95DurationMs: 5,
				lastResizedAt: '2026-07-01T00:00:00.000Z',
			},
		];
		const recommendations = {
			threshold: { minRequests: 3 },
			items: [],
		};
		const analytics = {
			getSummary: jest.fn().mockResolvedValue(summary),
			getTimeseries: jest.fn().mockResolvedValue({
				interval: 'hour',
				points: [],
			}),
			listTopImages: jest.fn().mockResolvedValue({
				items: [image],
				nextCursor: 'img.v1.opaque',
			}),
			getImage: jest.fn().mockResolvedValue(image),
			listVariants: jest.fn().mockResolvedValue(variants),
			listResizeRecommendations: jest.fn().mockResolvedValue(recommendations),
		} satisfies AdminAnalyticsRepository;
		const service = new AdminQueryService(
			telemetryRepository,
			lifecycleRepository,
			analytics,
		);

		await expect(service.getSummary(summary.range)).resolves.toBe(summary);
		await expect(
			service.getTimeseries({ ...summary.range, interval: 'hour' }),
		).resolves.toEqual({ interval: 'hour', points: [] });
		await expect(
			service.listImages({ sort: 'reads', limit: 25 }),
		).resolves.toEqual({ items: [image], nextCursor: 'img.v1.opaque' });
		await expect(service.getImage(image.imageKey)).resolves.toBe(image);
		await expect(service.listImageVariants(image.imageKey)).resolves.toEqual({
			items: variants,
		});
		await expect(
			service.listImageResizeRecommendations({ minRequests: 3 }),
		).resolves.toBe(recommendations);

		expect(telemetryRepository.listEvents).not.toHaveBeenCalled();
		expect(telemetryRepository.listAssets).not.toHaveBeenCalled();
		expect(telemetryRepository.listVariants).not.toHaveBeenCalled();
	});

	it('maps a missing database image to the existing 404 contract', async () => {
		const analytics = {
			getImage: jest.fn().mockResolvedValue(undefined),
		} as unknown as AdminAnalyticsRepository;
		const service = new AdminQueryService(
			{} as TelemetryRepository,
			{} as LifecycleRepository,
			analytics,
		);

		await expect(service.getImage('missing.png')).rejects.toThrow(
			'image not found',
		);
	});
});
