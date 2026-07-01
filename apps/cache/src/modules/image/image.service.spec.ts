jest.mock('src/config', () => ({
	envConfig: {
		RESIZING_SERVER: 'http://resize.test',
	},
}));

import { NotFoundException } from '@nestjs/common';
import { CacheService, CachedImage } from '../node-cache/cache.service';
import { ImageService } from './image.service';

const createFetchResponse = (
	body: Buffer,
	options: { status?: number; contentType?: string } = {},
) =>
	new Response(new Uint8Array(body), {
		status: options.status ?? 200,
		headers: options.contentType
			? { 'content-type': options.contentType }
			: undefined,
	});

describe('캐시 이미지 서비스', () => {
	let cacheService: jest.Mocked<
		Pick<CacheService, 'getCachedImage' | 'cacheImage'>
	>;
	let service: ImageService;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;

	beforeEach(() => {
		cacheService = {
			getCachedImage: jest.fn(),
			cacheImage: jest.fn(),
		};
		service = new ImageService(cacheService as unknown as CacheService);
		fetchSpy = jest.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('캐시된 이미지가 있으면 리사이즈 앱에 요청하지 않고 반환한다', async () => {
		const cachedImage: CachedImage = {
			imageBuffer: Buffer.from('cached'),
			contentType: 'image/png',
		};
		cacheService.getCachedImage.mockReturnValue(cachedImage);

		const result = await service.getCacheImage({
			path: 'public',
			name: 'sample.png',
			width: 100,
		});

		expect(result).toBe(cachedImage);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(cacheService.cacheImage).not.toHaveBeenCalled();
	});

	it('캐시가 없으면 리사이즈 앱에 요청하고 응답을 저장한 뒤 반환한다', async () => {
		const resized = Buffer.from('resized-image');
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockResolvedValue(
			createFetchResponse(resized, { contentType: 'image/webp' }),
		);

		const result = await service.getCacheImage({
			path: 'public',
			name: 'sample.webp',
			width: 100,
		});

		expect(fetchSpy).toHaveBeenCalledWith(
			'http://resize.test/image/public/sample.webp?width=100',
		);
		expect(result.contentType).toBe('image/webp');
		expect(result.imageBuffer.equals(resized)).toBe(true);
		expect(cacheService.cacheImage).toHaveBeenCalledWith(
			'public_100/xsample.webp',
			{
				imageBuffer: resized,
				contentType: 'image/webp',
			},
		);
	});

	it('리사이즈 앱이 콘텐츠 타입을 주지 않으면 파일 확장자를 대체값으로 사용한다', async () => {
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockResolvedValue(createFetchResponse(Buffer.from('jpeg-image')));

		const result = await service.getCacheImage({
			path: 'public',
			name: 'sample.jpg',
		});

		expect(result.contentType).toBe('image/jpeg');
	});

	it('리사이즈 앱에서 이미지를 찾지 못하면 NotFoundException을 던진다', async () => {
		cacheService.getCachedImage.mockReturnValue(undefined);
		fetchSpy.mockResolvedValue(
			createFetchResponse(Buffer.from('not-found'), { status: 404 }),
		);

		await expect(
			service.getCacheImage({ path: 'public', name: 'missing.png' }),
		).rejects.toBeInstanceOf(NotFoundException);
		expect(cacheService.cacheImage).not.toHaveBeenCalled();
	});
});
