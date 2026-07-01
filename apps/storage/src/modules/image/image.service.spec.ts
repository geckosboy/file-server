import { ClientKafka } from '@nestjs/microservices';
import { Readable } from 'stream';
import { of, throwError } from 'rxjs';
import { JpegStrategy } from './strategies/sharp/jpeg.strategy';
import { PngStrategy } from './strategies/sharp/png.strategy';
import { ImageManager } from './strategies/manager';
import { ImageService } from './image.service';

const createMulterFile = (overrides: Partial<Express.Multer.File> = {}) => {
	const buffer = Buffer.from('file-buffer');

	return {
		fieldname: 'file',
		originalname: 'sample.png',
		encoding: '7bit',
		mimetype: 'image/png',
		size: buffer.byteLength,
		destination: '/tmp',
		filename: 'temp-file.png',
		path: '/tmp/temp-file.png',
		buffer,
		stream: Readable.from(buffer),
		...overrides,
	} as Express.Multer.File;
};

describe('스토리지 이미지 서비스', () => {
	let imageManager: jest.Mocked<
		Pick<
			ImageManager,
			| 'saveImageFromTemp'
			| 'deleteMainImage'
			| 'deleteTempImage'
			| 'getBufferImage'
		>
	>;
	let imageClient: jest.Mocked<Pick<ClientKafka, 'emit'>>;
	let service: ImageService;

	beforeEach(() => {
		imageManager = {
			saveImageFromTemp: jest.fn().mockResolvedValue({
				format: 'png',
				size: 128,
			}),
			deleteMainImage: jest.fn().mockResolvedValue(undefined),
			deleteTempImage: jest.fn().mockResolvedValue(undefined),
			getBufferImage: jest.fn(),
		};
		imageClient = {
			emit: jest.fn().mockReturnValue(of({ ok: true })),
		};
		service = new ImageService(
			new PngStrategy(),
			new JpegStrategy(),
			imageManager as unknown as ImageManager,
			imageClient as unknown as ClientKafka,
		);
	});

	it('업로드된 PNG를 원본 파일명으로 압축해 저장한다', async () => {
		const file = createMulterFile({
			originalname: 'original name.png',
			filename: 'temp-name.png',
		});

		const result = await service.compressAndSaveImage({
			file,
			apiInfo: { id: 10, path: 'products/image' },
		});

		expect(result.format).toBe('png');
		expect(imageManager.saveImageFromTemp).toHaveBeenCalledWith(
			expect.any(PngStrategy),
			{
				mainName: 'original_name.png',
				tempName: 'temp-name.png',
				savePath: 'products/image',
			},
		);
	});

	it('파일 업로드 후 메타데이터를 발행하고 이전 이미지와 임시 파일을 정리한다', async () => {
		const file = createMulterFile();

		await service.uploadFile({
			file,
			apiInfo: {
				id: 10,
				path: 'products/image',
				beforeName: 'previous.png',
			},
		});

		expect(imageClient.emit).toHaveBeenCalledWith('image-topic', {
			key: 'uploadResult-json',
			value: expect.stringContaining('"id":10'),
		});
		expect(imageManager.deleteMainImage).toHaveBeenCalledWith({
			path: 'products/image',
			name: 'previous.png',
		});
		expect(imageManager.deleteTempImage).toHaveBeenCalledWith(file.filename);
	});

	it('저장 후 Kafka 발행이 실패해도 임시 파일을 정리한다', async () => {
		const file = createMulterFile();
		imageClient.emit.mockReturnValue(throwError(() => new Error('kafka down')));

		await expect(
			service.uploadFile({
				file,
				apiInfo: {
					id: 10,
					path: 'products/image',
				},
			}),
		).rejects.toThrow('kafka down');

		expect(imageManager.deleteTempImage).toHaveBeenCalledWith(file.filename);
	});

	it('메인 이미지 디렉터리 규칙에 맞춰 이미지 버퍼를 가져온다', async () => {
		const image = Buffer.from('stored-image');
		imageManager.getBufferImage.mockResolvedValue({
			image,
			name: 'sample.png',
		});

		const result = await service.getImage({
			path: 'products',
			name: 'sample.png',
		});

		expect(imageManager.getBufferImage).toHaveBeenCalledWith({
			path: 'products/image',
			name: 'sample.png',
		});
		expect(result.image).toBe(image);
	});
});
