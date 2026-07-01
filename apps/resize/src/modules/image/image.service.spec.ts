jest.mock('src/config', () => ({
	envConfig: {
		STORAGE_SERVER: 'http://storage.test',
	},
}));

import {
	InternalServerErrorException,
	NotFoundException,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { ImageManager } from './manager';
import { ImageService } from './image.service';

const createFetchResponse = (body: Buffer, status = 200) =>
	new Response(new Uint8Array(body), { status });

describe('리사이즈 이미지 서비스', () => {
	let imageManager: jest.Mocked<Pick<ImageManager, 'resize'>>;
	let service: ImageService;
	let fetchSpy: jest.SpiedFunction<typeof fetch>;

	beforeEach(() => {
		imageManager = {
			resize: jest.fn(),
		};
		service = new ImageService(
			imageManager as unknown as ImageManager,
			{} as ClientKafka,
		);
		fetchSpy = jest.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('스토리지 앱에서 원본 이미지를 버퍼로 가져온다', async () => {
		const originalImage = Buffer.from('original-image');
		fetchSpy.mockResolvedValue(createFetchResponse(originalImage));

		const result = await service.getImageFromMain({
			path: 'public',
			name: 'sample.png',
		});

		expect(fetchSpy).toHaveBeenCalledWith(
			'http://storage.test/image/public/sample.png',
			{ method: 'get' },
		);
		expect(result.equals(originalImage)).toBe(true);
	});

	it('스토리지 앱이 404를 반환하면 NotFoundException을 던진다', async () => {
		fetchSpy.mockResolvedValue(
			createFetchResponse(Buffer.from('missing'), 404),
		);

		await expect(
			service.getImageFromMain({ path: 'public', name: 'missing.png' }),
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('스토리지 앱이 404가 아닌 오류를 반환하면 InternalServerErrorException을 던진다', async () => {
		fetchSpy.mockResolvedValue(createFetchResponse(Buffer.from('error'), 500));

		await expect(
			service.getImageFromMain({ path: 'public', name: 'error.png' }),
		).rejects.toBeInstanceOf(InternalServerErrorException);
	});

	it('스토리지 앱이 빈 본문을 반환하면 NotFoundException을 던진다', async () => {
		fetchSpy.mockResolvedValue(createFetchResponse(Buffer.alloc(0)));

		await expect(
			service.getImageFromMain({ path: 'public', name: 'empty.png' }),
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('원본 이미지를 가져온 뒤 ImageManager에 리사이징을 위임한다', async () => {
		const originalImage = Buffer.from('original-image');
		const resizedImage = Buffer.from('resized-image');
		jest.spyOn(service, 'getImageFromMain').mockResolvedValue(originalImage);
		imageManager.resize.mockResolvedValue(resizedImage);

		const result = await service.resizeImage({
			path: 'public',
			name: 'sample.png',
			width: 100,
			height: 50,
		});

		expect(service.getImageFromMain).toHaveBeenCalledWith({
			path: 'public',
			name: 'sample.png',
		});
		expect(imageManager.resize).toHaveBeenCalledWith(originalImage, {
			width: 100,
			height: 50,
		});
		expect(result).toBe(resizedImage);
	});
});
