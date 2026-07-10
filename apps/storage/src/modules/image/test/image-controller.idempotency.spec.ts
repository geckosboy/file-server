import {
	ClientServiceAuthContext,
	ClientServiceAuthorizationService,
} from '@file/database';
import { Response } from 'express';
import { Readable } from 'stream';
import { ImageController } from '.././image.controller';
import { ImageService } from '.././image.service';
import {
	getImageUploadIdempotencyMetrics,
	resetImageUploadIdempotencyMetricsForTesting,
	resolveImageUploadIdempotencyKey,
} from '.././image-upload-idempotency';

const context: ClientServiceAuthContext = {
	clientServiceId: 'service-1',
	clientServiceSlug: 'local-demo',
	clientServiceName: 'Local Demo',
	clientServiceKeyId: 'key-1',
	keyPrefix: 'prefix-1',
	requestId: 'request-1',
	traceId: 'trace-1',
};

const file = {
	fieldname: 'file',
	originalname: 'sample.png',
	encoding: '7bit',
	mimetype: 'image/png',
	size: 10,
	destination: '/tmp',
	filename: 'temp.png',
	path: '/tmp/temp.png',
	buffer: Buffer.from('image'),
	stream: Readable.from('image'),
} as Express.Multer.File;

describe('이미지 업로드 HTTP idempotency adapter', () => {
	beforeEach(() => {
		resetImageUploadIdempotencyMetricsForTesting();
	});

	it('Idempotency-Key header를 lifecycle upload 입력으로 전달한다', async () => {
		const uploadResult = {
			assetId: 'asset-1',
			variantStatus: 'Pending',
		};
		const uploadFile = jest.fn().mockResolvedValue(uploadResult);
		const controller = new ImageController(
			{ uploadFile } as unknown as ImageService,
			{} as ClientServiceAuthorizationService,
		);
		const response = createResponse();

		await controller.uploadFile(
			response,
			context,
			{ path: 'products/image', externalImageId: 10 },
			file,
			' retry-key-1 ',
		);

		expect(uploadFile).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: resolveImageUploadIdempotencyKey({
					headerValue: 'retry-key-1',
					clientServiceContext: context,
					path: 'products/image',
					originalName: 'sample.png',
					externalImageId: 10,
				}),
			}),
		);
		expect(response.status).toHaveBeenCalledWith(201);
		expect(response.json).toHaveBeenCalledWith(uploadResult);
	});

	it('header가 없으면 tenant/path/externalImageId가 같은 재시도에 안정적인 fallback을 쓴다', () => {
		const first = resolveImageUploadIdempotencyKey({
			clientServiceContext: context,
			path: 'products/image',
			originalName: 'sample.png',
			externalImageId: 10,
		});
		const retried = resolveImageUploadIdempotencyKey({
			clientServiceContext: { ...context, requestId: 'request-2' },
			path: 'products/image',
			originalName: 'renamed.png',
			externalImageId: 10,
		});

		expect(retried).toBe(first);
	});

	it('externalImageId도 없으면 signed requestId와 원본 이름으로 fallback한다', () => {
		const first = resolveImageUploadIdempotencyKey({
			clientServiceContext: context,
			path: 'products/image',
			originalName: 'sample.png',
		});
		const retried = resolveImageUploadIdempotencyKey({
			clientServiceContext: context,
			path: 'products/image',
			originalName: 'sample.png',
		});

		expect(first).toMatch(/^image-upload:v1:[0-9a-f]{64}$/);
		expect(retried).toBe(first);
	});

	it('legacy client는 transition 기간에 generated weak key로 계속 성공한다', () => {
		const legacyContext = {
			...context,
			requestId: undefined,
		} as unknown as ClientServiceAuthContext;

		const key = resolveImageUploadIdempotencyKey({
			clientServiceContext: legacyContext,
			path: 'products/image',
			originalName: 'sample.png',
			strict: false,
		});

		expect(key).toMatch(/^image-upload:v1:[0-9a-f]{64}$/);
		expect(getImageUploadIdempotencyMetrics()).toEqual({
			legacyGeneratedKeyCount: 1,
		});
	});

	it('strict cutover 뒤에는 durable key가 없는 legacy client를 거부한다', () => {
		const legacyContext = {
			...context,
			requestId: undefined,
		} as unknown as ClientServiceAuthContext;

		expect(() =>
			resolveImageUploadIdempotencyKey({
				clientServiceContext: legacyContext,
				path: 'products/image',
				originalName: 'sample.png',
				strict: true,
			}),
		).toThrow('Idempotency-Key, externalImageId 또는 requestId가 필요합니다.');
		expect(getImageUploadIdempotencyMetrics()).toEqual({
			legacyGeneratedKeyCount: 0,
		});
	});
});

const createResponse = () => {
	const response = {
		status: jest.fn(),
		json: jest.fn(),
	};
	response.status.mockReturnValue(response);
	return response as unknown as Response;
};
