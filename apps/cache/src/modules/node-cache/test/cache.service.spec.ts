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
});
