import { CacheService, CachedImage } from '.././cache.service';

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

	it('같은 원본 이미지의 리사이즈 캐시를 한 번에 삭제한다', () => {
		const service = new CacheService(60);
		const cachedImage: CachedImage = {
			imageBuffer: Buffer.from('cached-image'),
			contentType: 'image/png',
		};

		service.cacheImage('products|100|x|sample.png', cachedImage);
		service.cacheImage('products|200|200|sample.png', cachedImage);
		service.cacheImage('products|100|x|other.png', cachedImage);

		const deletedCount = service.deleteCachedImagesForImage({
			path: 'products',
			name: 'sample.png',
		});

		expect(deletedCount).toBe(2);
		expect(service.getCachedImage('products|100|x|sample.png')).toBeUndefined();
		expect(
			service.getCachedImage('products|200|200|sample.png'),
		).toBeUndefined();
		expect(service.getCachedImage('products|100|x|other.png')).toBe(
			cachedImage,
		);
	});
});
