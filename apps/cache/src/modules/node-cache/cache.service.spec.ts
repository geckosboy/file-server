import { CacheService, CachedImage } from './cache.service';

describe('캐시 서비스', () => {
	it('이미지를 복제하지 않고 같은 객체로 저장하고 반환한다', () => {
		const service = new CacheService(60);
		const cachedImage: CachedImage = {
			imageBuffer: Buffer.from('cached-image'),
			contentType: 'image/png',
		};

		service.cacheImage('image-key', cachedImage);

		expect(service.getCachedImage('image-key')).toBe(cachedImage);
	});

	it('없는 캐시 키에는 undefined를 반환한다', () => {
		const service = new CacheService(60);

		expect(service.getCachedImage('missing-key')).toBeUndefined();
	});
});
