jest.mock('src/config', () => ({
	envConfig: {
		RESIZING_SERVER: 'http://resize.test',
		INTERNAL_API_KEY: 'internal-test-key',
		UPSTREAM_HTTP_TIMEOUT_MS: 20,
		UPSTREAM_HTTP_MAX_RETRIES: 1,
		UPSTREAM_HTTP_RETRY_BACKOFF_MS: 0,
		UPSTREAM_IMAGE_MAX_RESPONSE_BYTES: 1_024,
	},
}));

import { AppConfig } from '../../../config/env.schema';
import { CacheInvalidationConsumerService } from '../cache-invalidation-consumer.service';
import { createImageCacheInvalidationEvent } from '@file/telemetry-contracts/image-operations';
import { ImageService } from '../image.service';

describe('cache invalidation Kafka consumer', () => {
	const originalNodeEnv = process.env.NODE_ENV;

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
	});

	it('applies a tenant-scoped invalidation idempotently and exposes metrics', () => {
		process.env.NODE_ENV = 'test';
		const imageService = {
			deleteCacheImage: jest.fn().mockReturnValue({ deletedCount: 2 }),
		};
		const service = new CacheInvalidationConsumerService(
			{ kafkaClientBrokerList: ['localhost:9092'] } as AppConfig,
			imageService as unknown as ImageService,
		);
		const event = createImageCacheInvalidationEvent({
			eventId: 'delete-event-1',
			clientServiceId: 'service-1',
			path: 'products',
			name: 'sample.png',
			reason: 'delete',
		});

		service.handlePayload(Buffer.from(JSON.stringify(event)));

		expect(imageService.deleteCacheImage).toHaveBeenCalledWith({
			clientServiceId: 'service-1',
			path: 'products',
			name: 'sample.png',
		});
		expect(service.getMetrics()).toEqual(
			expect.objectContaining({
				processedTotal: 1,
				invalidatedEntriesTotal: 2,
				ready: true,
			}),
		);
	});

	it('rejects poison payload before mutating the cache', () => {
		process.env.NODE_ENV = 'test';
		const imageService = { deleteCacheImage: jest.fn() };
		const service = new CacheInvalidationConsumerService(
			{ kafkaClientBrokerList: [] } as unknown as AppConfig,
			imageService as unknown as ImageService,
		);

		expect(() =>
			service.handlePayload(Buffer.from('{"schemaVersion":2}')),
		).toThrow();
		expect(imageService.deleteCacheImage).not.toHaveBeenCalled();
	});

	it('writes poison source metadata to DLQ before committing offset + 1', async () => {
		process.env.NODE_ENV = 'test';
		const service = new CacheInvalidationConsumerService(
			{ kafkaClientBrokerList: [] } as unknown as AppConfig,
			{ deleteCacheImage: jest.fn() } as unknown as ImageService,
		);
		const commitOffsets = jest.fn().mockResolvedValue(undefined);
		const send = jest.fn().mockResolvedValue(undefined);
		const internals = service as unknown as {
			consumer: { commitOffsets: typeof commitOffsets };
			producer: { send: typeof send };
			handleMessage(payload: unknown): Promise<void>;
		};
		internals.consumer = { commitOffsets };
		internals.producer = { send };

		await internals.handleMessage({
			topic: 'file.image.cache-invalidation.v1',
			partition: 2,
			message: {
				offset: '41',
				key: Buffer.from('bad-key'),
				value: Buffer.from('{"schemaVersion":2}'),
			},
		});

		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				topic: 'file.image.cache-invalidation.v1.dlq',
				acks: -1,
			}),
		);
		const dlqValue = JSON.parse(
			(send.mock.calls[0][0].messages[0] as { value: string }).value,
		);
		expect(dlqValue).toEqual(
			expect.objectContaining({
				sourceTopic: 'file.image.cache-invalidation.v1',
				partition: 2,
				offset: '41',
				rawPayloadBase64: Buffer.from('{"schemaVersion":2}').toString('base64'),
			}),
		);
		expect(commitOffsets).toHaveBeenCalledWith([
			{
				topic: 'file.image.cache-invalidation.v1',
				partition: 2,
				offset: '42',
			},
		]);
	});
});
