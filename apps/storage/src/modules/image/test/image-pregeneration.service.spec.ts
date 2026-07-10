import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '@file/database';
import { ImagePregenerationService } from '.././image-pregeneration.service';
import { ImageManager } from '.././strategies/manager';
import { ImageVariantJobRepository } from '../image-variant-job.repository';

type PrismaMock = {
	clientServiceImageResizePolicy: {
		findUnique: jest.Mock;
	};
	imageAsset: { findUnique: jest.Mock };
	imageVariant: { findFirst: jest.Mock };
};

const createPrismaMock = (): PrismaMock => ({
	clientServiceImageResizePolicy: {
		findUnique: jest.fn(),
	},
	imageAsset: { findUnique: jest.fn() },
	imageVariant: { findFirst: jest.fn() },
});

const originalDualReadFlag = process.env.IMAGE_ASSET_DUAL_READ_ENABLED;

describe('이미지 사전 리사이징 서비스', () => {
	let prisma: PrismaMock;
	let imageManager: jest.Mocked<
		Pick<ImageManager, 'createPreGeneratedVariant' | 'getBufferImage'>
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
				checksum: 'a'.repeat(64),
			}),
			getBufferImage: jest.fn().mockResolvedValue({
				image: Buffer.from('variant-image'),
				name: 'sample__w400_h400.webp',
			}),
		};
		service = new ImagePregenerationService(
			prisma as unknown as PrismaService,
			imageManager as unknown as ImageManager,
		);
	});

	afterEach(() => {
		if (originalDualReadFlag === undefined) {
			delete process.env.IMAGE_ASSET_DUAL_READ_ENABLED;
		} else {
			process.env.IMAGE_ASSET_DUAL_READ_ENABLED = originalDualReadFlag;
		}
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

	it('Authoritative lifecycle sync compatibility는 durable job을 claim하고 Ready로 완료한다', async () => {
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
		const metadata = {
			claimJob: jest.fn().mockResolvedValue('claimed'),
			completeJob: jest.fn().mockResolvedValue(true),
			failJob: jest.fn(),
		};
		service = new ImagePregenerationService(
			prisma as unknown as PrismaService,
			imageManager as unknown as ImageManager,
			metadata as unknown as ImageVariantJobRepository,
		);

		const results = await service.preGenerateForUpload({
			clientServiceId: 'service-1',
			assetId: 'asset-1',
			sourceChecksum: 'source-checksum',
			path: 'products/image',
			name: 'sample.png',
		});

		expect(metadata.claimJob).toHaveBeenCalledWith(
			expect.objectContaining({
				assetId: 'asset-1',
				sourceChecksum: 'source-checksum',
			}),
		);
		expect(metadata.completeJob).toHaveBeenCalledWith(
			expect.objectContaining({ assetId: 'asset-1' }),
			{
				name: 'sample__w400_h400.webp',
				storageKey: 'products/image/sample__w400_h400.webp',
				inputBytes: 128,
				outputBytes: 42,
				checksum: 'a'.repeat(64),
			},
		);
		expect(results).toEqual([
			expect.objectContaining({ status: 'success', variantId: 'variant-1' }),
		]);
		expect(metadata.failJob).not.toHaveBeenCalled();
	});

	it('Authoritative lifecycle sync compatibility는 delete/terminal job을 Ready 성공으로 오인하지 않는다', async () => {
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
		const variantJobs = {
			claimJob: jest.fn().mockResolvedValue('discarded'),
			completeJob: jest.fn(),
			failJob: jest.fn(),
		};
		service = new ImagePregenerationService(
			prisma as unknown as PrismaService,
			imageManager as unknown as ImageManager,
			variantJobs as unknown as ImageVariantJobRepository,
		);

		await expect(
			service.preGenerateForUpload({
				clientServiceId: 'service-1',
				assetId: 'asset-1',
				sourceChecksum: 'source-checksum',
				path: 'products/image',
				name: 'sample.png',
			}),
		).resolves.toEqual([
			expect.objectContaining({
				variantId: 'variant-1',
				status: 'failed',
				error: expect.objectContaining({
					message: expect.stringContaining('variant job is terminal'),
				}),
			}),
		]);
		expect(imageManager.createPreGeneratedVariant).not.toHaveBeenCalled();
		expect(variantJobs.completeJob).not.toHaveBeenCalled();
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

	it('요청 width/height/format과 일치하는 pre-generated variant 파일을 찾는다', async () => {
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
				{
					id: 'variant-2',
					width: 800,
					height: 600,
					format: 'jpeg',
				},
			],
		});

		const result = await service.findPreGeneratedVariantForRequest({
			clientServiceId: 'service-1',
			path: 'products/image',
			name: 'sample.png',
			width: 400,
			height: 400,
			format: 'webp',
		});

		expect(imageManager.getBufferImage).toHaveBeenCalledWith({
			path: 'products/image',
			name: 'sample__w400_h400.webp',
		});
		expect(result).toEqual({
			image: Buffer.from('variant-image'),
			name: 'sample__w400_h400.webp',
			width: 400,
			height: 400,
			format: 'webp',
		});
	});

	it('authoritative variant가 Ready이고 source checksum이 일치할 때만 파일을 읽는다', async () => {
		prisma.clientServiceImageResizePolicy.findUnique.mockResolvedValue({
			id: 'policy-1',
			clientServiceId: 'service-1',
			mode: 'PRE_GENERATE',
			variants: [{ id: 'variant-1', width: 400, height: 400, format: 'webp' }],
		});
		prisma.imageVariant.findFirst.mockResolvedValue({
			storageKey: 'products/image/sample__w400_h400.webp',
		});

		await expect(
			service.findPreGeneratedVariantForRequest({
				clientServiceId: 'service-1',
				path: 'products/image',
				name: 'sample.png',
				width: 400,
				height: 400,
				format: 'webp',
				authoritativeAsset: {
					assetId: 'asset-1',
					sourceChecksum: 'source-checksum',
				},
			}),
		).resolves.toEqual(
			expect.objectContaining({ name: 'sample__w400_h400.webp' }),
		);
		expect(prisma.imageVariant.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					assetId: 'asset-1',
					sourceChecksum: 'source-checksum',
					status: 'Ready',
				}),
			}),
		);
	});

	it('authoritative variant가 Pending이면 canonical 파일이 있어도 제공하지 않는다', async () => {
		prisma.clientServiceImageResizePolicy.findUnique.mockResolvedValue({
			id: 'policy-1',
			clientServiceId: 'service-1',
			mode: 'PRE_GENERATE',
			variants: [{ id: 'variant-1', width: 400, height: 400, format: 'webp' }],
		});
		prisma.imageVariant.findFirst.mockResolvedValue(null);

		await expect(
			service.findPreGeneratedVariantForRequest({
				clientServiceId: 'service-1',
				path: 'products/image',
				name: 'sample.png',
				width: 400,
				height: 400,
				format: 'webp',
				authoritativeAsset: {
					assetId: 'asset-1',
					sourceChecksum: 'source-checksum',
				},
			}),
		).resolves.toBeNull();
		expect(imageManager.getBufferImage).not.toHaveBeenCalled();
	});

	it('Deleted/Pending source metadata와 contract-only mode의 missing metadata를 읽지 않는다', async () => {
		prisma.imageAsset.findUnique.mockResolvedValue({
			assetId: 'asset-1',
			checksum: 'checksum',
			status: 'Deleted',
		});
		await expect(
			service.assertSourceReadable({
				clientServiceId: 'service-1',
				path: 'products/image',
				name: 'sample.png',
			}),
		).rejects.toBeInstanceOf(NotFoundException);

		process.env.IMAGE_ASSET_DUAL_READ_ENABLED = 'false';
		prisma.imageAsset.findUnique.mockResolvedValue(null);
		await expect(
			service.assertSourceReadable({
				clientServiceId: 'service-1',
				path: 'products/image',
				name: 'sample.png',
			}),
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('variant 정책은 있지만 파일이 없으면 기존 조회 흐름으로 fallback한다', async () => {
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
		imageManager.getBufferImage.mockRejectedValue(new Error('missing'));

		await expect(
			service.findPreGeneratedVariantForRequest({
				clientServiceId: 'service-1',
				path: 'products/image',
				name: 'sample.png',
				width: 400,
				height: 400,
				format: 'webp',
			}),
		).resolves.toBeNull();
	});
});
