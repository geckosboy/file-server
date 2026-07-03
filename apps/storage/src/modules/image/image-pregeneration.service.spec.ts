import { PrismaService } from '@file/database';
import { ImagePregenerationService } from './image-pregeneration.service';
import { ImageManager } from './strategies/manager';

type PrismaMock = {
	clientServiceImageResizePolicy: {
		findUnique: jest.Mock;
	};
};

const createPrismaMock = (): PrismaMock => ({
	clientServiceImageResizePolicy: {
		findUnique: jest.fn(),
	},
});

describe('이미지 사전 리사이징 서비스', () => {
	let prisma: PrismaMock;
	let imageManager: jest.Mocked<
		Pick<ImageManager, 'createPreGeneratedVariant'>
	>;
	let service: ImagePregenerationService;

	beforeEach(() => {
		prisma = createPrismaMock();
		imageManager = {
			createPreGeneratedVariant: jest.fn().mockResolvedValue({
				name: 'sample__w400_h400.webp',
				width: 400,
				height: 400,
				format: 'webp',
				inputBytes: 128,
				outputBytes: 42,
			}),
		};
		service = new ImagePregenerationService(
			prisma as unknown as PrismaService,
			imageManager as unknown as ImageManager,
		);
	});

	it('PRE_GENERATE 정책의 활성 variant를 조회해 사전 리사이징한다', async () => {
		prisma.clientServiceImageResizePolicy.findUnique.mockResolvedValue({
			id: 'policy-1',
			clientServiceId: 'service-1',
			mode: 'PRE_GENERATE',
			variants: [
				{
					id: 'variant-1',
					width: 400,
					height: 400,
					format: 'webp',
				},
			],
		});

		const results = await service.preGenerateForUpload({
			clientServiceId: 'service-1',
			path: 'products/image',
			name: 'sample.png',
		});

		expect(
			prisma.clientServiceImageResizePolicy.findUnique,
		).toHaveBeenCalledWith({
			where: { clientServiceId: 'service-1' },
			include: {
				variants: {
					where: { isEnabled: true },
					orderBy: [{ width: 'asc' }, { height: 'asc' }, { format: 'asc' }],
				},
			},
		});
		expect(imageManager.createPreGeneratedVariant).toHaveBeenCalledWith({
			path: 'products/image',
			name: 'sample.png',
			width: 400,
			height: 400,
			format: 'webp',
		});
		expect(results).toEqual([
			expect.objectContaining({
				variantId: 'variant-1',
				width: 400,
				height: 400,
				format: 'webp',
				variantName: 'sample__w400_h400.webp',
				inputBytes: 128,
				outputBytes: 42,
				durationMs: expect.any(Number),
				status: 'success',
			}),
		]);
	});

	it('ON_DEMAND 정책은 기존 흐름을 유지하도록 아무 작업도 하지 않는다', async () => {
		prisma.clientServiceImageResizePolicy.findUnique.mockResolvedValue({
			id: 'policy-1',
			clientServiceId: 'service-1',
			mode: 'ON_DEMAND',
			variants: [
				{
					id: 'variant-1',
					width: 400,
					height: 400,
					format: 'webp',
				},
			],
		});

		const results = await service.preGenerateForUpload({
			clientServiceId: 'service-1',
			path: 'products/image',
			name: 'sample.png',
		});

		expect(results).toEqual([]);
		expect(imageManager.createPreGeneratedVariant).not.toHaveBeenCalled();
	});

	it('variant 생성 실패를 결과로 남기고 다른 업로드 흐름으로 예외를 던지지 않는다', async () => {
		prisma.clientServiceImageResizePolicy.findUnique.mockResolvedValue({
			id: 'policy-1',
			clientServiceId: 'service-1',
			mode: 'PRE_GENERATE',
			variants: [
				{
					id: 'variant-1',
					width: 800,
					height: null,
					format: 'jpeg',
				},
			],
		});
		imageManager.createPreGeneratedVariant.mockRejectedValue(
			new Error('sharp failed'),
		);

		const results = await service.preGenerateForUpload({
			clientServiceId: 'service-1',
			path: 'products/image',
			name: 'sample.png',
		});

		expect(results).toEqual([
			expect.objectContaining({
				variantId: 'variant-1',
				width: 800,
				height: undefined,
				format: 'jpeg',
				status: 'failed',
				error: expect.any(Error),
			}),
		]);
	});
});
