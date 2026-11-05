import {
	IMAGE_CACHE_INVALIDATION_TOPIC,
	IMAGE_VARIANT_JOB_TOPIC,
	createImageCacheInvalidationEvent,
	createImageCacheInvalidationKafkaKey,
	createImageVariantJobEvent,
	createImageVariantJobKafkaKey,
	validateImageCacheInvalidationEvent,
	validateImageVariantJobEvent,
} from '../image-operations';

describe('authoritative image operation contracts', () => {
	it('creates an idempotent variant job key from asset/spec/checksum', () => {
		const event = createImageVariantJobEvent({
			assetId: 'asset-1',
			clientServiceId: 'service-1',
			path: 'products/image',
			name: 'sample.png',
			sourceChecksum: 'sha256:abc',
			width: 400,
			format: 'webp',
		});

		expect(IMAGE_VARIANT_JOB_TOPIC).toBe('file.image.variant.jobs.v1');
		expect(event.jobKey).toBe('asset-1:400:auto:webp:sha256:abc');
		expect(createImageVariantJobKafkaKey(event)).toBe(event.jobKey);
		expect(validateImageVariantJobEvent(event)).toEqual({ ok: true, event });
	});

	it('rejects a variant job without a requested dimension', () => {
		const result = validateImageVariantJobEvent({
			schemaVersion: 1,
			eventId: 'event-1',
			eventType: 'image.variant.requested',
			occurredAt: new Date().toISOString(),
			jobKey: 'job-1',
			assetId: 'asset-1',
			clientServiceId: 'service-1',
			path: 'products/image',
			name: 'sample.png',
			sourceChecksum: 'sha256:abc',
			format: 'webp',
		});

		expect(result).toEqual(
			expect.objectContaining({
				ok: false,
				errors: expect.arrayContaining([
					'width 또는 height 중 하나는 필요합니다',
				]),
			}),
		);
	});

	it('creates a tenant-scoped cache invalidation event', () => {
		const event = createImageCacheInvalidationEvent({
			clientServiceId: 'service-1',
			path: 'products',
			name: 'sample.png',
			reason: 'delete',
			assetId: 'asset-1',
		});

		expect(IMAGE_CACHE_INVALIDATION_TOPIC).toBe(
			'file.image.cache-invalidation.v1',
		);
		expect(createImageCacheInvalidationKafkaKey(event)).toBe(
			'service-1:products/sample.png',
		);
		expect(validateImageCacheInvalidationEvent(event)).toEqual({
			ok: true,
			event,
		});
	});
});
