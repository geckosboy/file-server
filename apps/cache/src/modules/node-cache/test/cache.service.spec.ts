import { CacheService, CachedImage } from '.././cache.service';
import NodeCache from 'node-cache';

const getImageCache = (service: CacheService): NodeCache =>
	(service as unknown as { imageCache: NodeCache }).imageCache;

describe('캐시 서비스', () => {
	it('이미지를 복제하지 않고 같은 객체로 저장하고 반환한다', () => {
		const service = new CacheService(60, 1024);
		const cachedImage: CachedImage = {
			imageBuffer: Buffer.from('cached-image'),
			contentType: 'image/png',
		};

		service.cacheImage('image-key', cachedImage);

		expect(service.getCachedImage('image-key')).toBe(cachedImage);
	});

	it('없는 캐시 키에는 undefined를 반환한다', () => {
		const service = new CacheService(60, 1024);

		expect(service.getCachedImage('missing-key')).toBeUndefined();
		expect(service.getMetrics()).toMatchObject({ hits: 0, misses: 1 });
	});

	it('같은 원본 이미지의 리사이즈 캐시를 한 번에 삭제한다', () => {
		const service = new CacheService(60, 1024);
		const cachedImage: CachedImage = {
			imageBuffer: Buffer.from('cached-image'),
			contentType: 'image/png',
		};

		service.cacheImage('service-1|products|100|x|png|sample.png', cachedImage);
		service.cacheImage(
			'service-1|products|200|200|png|sample.png',
			cachedImage,
		);
		service.cacheImage('service-2|products|100|x|png|sample.png', cachedImage);

		const deletedCount = service.deleteCachedImagesForImage({
			clientServiceId: 'service-1',
			path: 'products',
			name: 'sample.png',
		});

		expect(deletedCount).toBe(2);
		expect(
			service.getCachedImage('service-1|products|100|x|png|sample.png'),
		).toBeUndefined();
		expect(
			service.getCachedImage('service-1|products|200|200|png|sample.png'),
		).toBeUndefined();
		expect(
			service.getCachedImage('service-2|products|100|x|png|sample.png'),
		).toBe(cachedImage);
	});

	it('총 byte budget을 넘으면 가장 오래 사용하지 않은 항목부터 퇴출한다', () => {
		const service = new CacheService(60, 10);
		const first: CachedImage = {
			imageBuffer: Buffer.alloc(4, 1),
			contentType: 'image/png',
		};
		const second: CachedImage = {
			imageBuffer: Buffer.alloc(4, 2),
			contentType: 'image/png',
		};
		const third: CachedImage = {
			imageBuffer: Buffer.alloc(4, 3),
			contentType: 'image/png',
		};

		service.cacheImage('first', first);
		service.cacheImage('second', second);
		expect(service.getCachedImage('first')).toBe(first);
		service.cacheImage('third', third);

		expect(service.getCachedImage('first')).toBe(first);
		expect(service.getCachedImage('second')).toBeUndefined();
		expect(service.getCachedImage('third')).toBe(third);
		expect(service.getMetrics()).toEqual({
			hits: 3,
			misses: 1,
			entries: 2,
			bytes: 8,
			maxBytes: 10,
			evictions: 1,
			oversizedSkips: 0,
		});
	});

	it('하나의 항목이 byte budget보다 크면 캐시하지 않는다', () => {
		const service = new CacheService(60, 4);

		service.cacheImage('oversized', {
			imageBuffer: Buffer.alloc(5),
			contentType: 'image/png',
		});

		expect(service.getCachedImage('oversized')).toBeUndefined();
		expect(service.getMetrics()).toMatchObject({
			entries: 0,
			bytes: 0,
			oversizedSkips: 1,
		});
	});

	it('기존 키를 교체할 때 byte 계수를 중복하지 않는다', () => {
		const service = new CacheService(60, 10);

		service.cacheImage('same', {
			imageBuffer: Buffer.alloc(6),
			contentType: 'image/png',
		});
		service.cacheImage('same', {
			imageBuffer: Buffer.alloc(3),
			contentType: 'image/webp',
		});

		expect(service.getMetrics()).toMatchObject({ entries: 1, bytes: 3 });
	});

	it('TTL이 만료한 항목을 byte 계수에서도 제거한다', () => {
		jest.useFakeTimers();
		try {
			const service = new CacheService(1, 10);
			service.cacheImage('expires', {
				imageBuffer: Buffer.alloc(4),
				contentType: 'image/png',
			});

			jest.advanceTimersByTime(600 * 1000);

			expect(service.getMetrics()).toMatchObject({ entries: 0, bytes: 0 });
			expect(service.getCachedImage('expires')).toBeUndefined();
		} finally {
			jest.useRealTimers();
		}
	});

	it('NodeCache set이 실패하면 metadata와 byte를 기록하지 않는다', () => {
		const service = new CacheService(60, 10);
		jest.spyOn(getImageCache(service), 'set').mockReturnValueOnce(false);

		service.cacheImage('failed', {
			imageBuffer: Buffer.alloc(4),
			contentType: 'image/png',
		});

		expect(service.getMetrics()).toMatchObject({ entries: 0, bytes: 0 });
	});

	it('NodeCache flush 후 metadata와 byte 계수를 초기화한다', () => {
		const service = new CacheService(60, 10);
		service.cacheImage('first', {
			imageBuffer: Buffer.alloc(4),
			contentType: 'image/png',
		});

		getImageCache(service).flushAll();

		expect(service.getMetrics()).toMatchObject({ entries: 0, bytes: 0 });
	});

	it('CACHE_MAX_BYTES 환경 설정을 기본 byte budget으로 사용한다', () => {
		const originalMaxBytes = process.env.CACHE_MAX_BYTES;
		process.env.CACHE_MAX_BYTES = '4';
		try {
			const service = new CacheService(60);
			service.cacheImage('oversized', {
				imageBuffer: Buffer.alloc(5),
				contentType: 'image/png',
			});

			expect(service.getMetrics()).toMatchObject({
				maxBytes: 4,
				entries: 0,
				oversizedSkips: 1,
			});
		} finally {
			if (originalMaxBytes === undefined) {
				delete process.env.CACHE_MAX_BYTES;
			} else {
				process.env.CACHE_MAX_BYTES = originalMaxBytes;
			}
		}
	});

	it('많은 최대 크기 항목을 입력해도 캐시 바이트와 RSS 증가를 제한한다', () => {
		const maxBytes = 1024 * 1024;
		const entryBytes = 256 * 1024;
		const service = new CacheService(60, maxBytes);
		const rssBefore = process.memoryUsage().rss;

		for (let index = 0; index < 64; index += 1) {
			service.cacheImage(`image-${index}`, {
				imageBuffer: Buffer.alloc(entryBytes, index),
				contentType: 'image/webp',
			});
		}

		const rssGrowth = process.memoryUsage().rss - rssBefore;
		expect(service.getMetrics()).toMatchObject({
			entries: 4,
			bytes: maxBytes,
			maxBytes,
		});
		expect(rssGrowth).toBeLessThan(64 * 1024 * 1024);
	});
});
