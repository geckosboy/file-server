import { ClientKafka } from '@nestjs/microservices';
import { of } from 'rxjs';
import { createImageVariantJobEvent } from '@file/telemetry-contracts/image-operations';
import { AppConfig } from '../../../config/env.schema';
import { ImageCacheInvalidationPublisher } from '../image-cache-invalidation.publisher';
import { ImageLifecycleMetricsService } from '../image-lifecycle-metrics.service';
import { ImageVariantJobDispatcher } from '../image-variant-job.dispatcher';
import { ImageVariantJobPublisher } from '../image-variant-job.publisher';
import { ImageVariantJobRepository } from '../image-variant-job.repository';
import { ImageVariantJobWorker } from '../image-variant-job.worker';
import { ImageManager } from '../strategies/manager';

const job = createImageVariantJobEvent({
	assetId: 'asset-1',
	clientServiceId: 'service-1',
	path: 'products/image',
	name: 'sample.png',
	sourceChecksum: 'source-checksum',
	width: 400,
	format: 'webp',
});

const createRepository = (): jest.Mocked<ImageVariantJobRepository> => ({
	createPendingJobs: jest.fn().mockResolvedValue([job]),
	listPublishableJobs: jest.fn().mockResolvedValue([job]),
	recordPublished: jest.fn().mockResolvedValue(undefined),
	recordPublishFailure: jest.fn().mockResolvedValue(undefined),
	claimJob: jest.fn().mockResolvedValue('claimed'),
	completeJob: jest.fn().mockResolvedValue(true),
	failJob: jest.fn().mockResolvedValue(undefined),
});

describe('Image variant job pipeline', () => {
	it('persists then publishes a durable job ledger event', async () => {
		const repository = createRepository();
		const publisher = { publish: jest.fn().mockResolvedValue(true) };
		const metrics = new ImageLifecycleMetricsService();
		const dispatcher = new ImageVariantJobDispatcher(
			repository,
			publisher as unknown as ImageVariantJobPublisher,
			metrics,
		);

		await expect(dispatcher.publishPersistedNow([job])).resolves.toBe(1);
		expect(publisher.publish).toHaveBeenCalledWith(job);
		expect(repository.recordPublished).toHaveBeenCalledWith(job.jobKey);
	});

	it('publishes variant jobs to the configured topic used by the worker', async () => {
		const previousTopic = process.env.IMAGE_VARIANT_KAFKA_TOPIC;
		process.env.IMAGE_VARIANT_KAFKA_TOPIC = 'custom.image.variant.jobs.v1';
		const emit = jest.fn().mockReturnValue(of({ ok: true }));
		const publisher = new ImageVariantJobPublisher(
			{ emit } as unknown as ClientKafka,
			new ImageLifecycleMetricsService(),
		);

		try {
			await expect(publisher.publish(job)).resolves.toBe(true);
		} finally {
			if (previousTopic === undefined) {
				delete process.env.IMAGE_VARIANT_KAFKA_TOPIC;
			} else {
				process.env.IMAGE_VARIANT_KAFKA_TOPIC = previousTopic;
			}
		}
		expect(emit).toHaveBeenCalledWith(
			'custom.image.variant.jobs.v1',
			expect.objectContaining({ value: JSON.stringify(job) }),
		);
	});

	it('contains background database failures without terminating storage', async () => {
		const previousInterval =
			process.env.IMAGE_VARIANT_OUTBOX_PUBLISH_INTERVAL_MS;
		process.env.IMAGE_VARIANT_OUTBOX_PUBLISH_INTERVAL_MS = '60000';
		const repository = createRepository();
		repository.listPublishableJobs.mockRejectedValue(
			new Error('database unavailable'),
		);
		const metrics = new ImageLifecycleMetricsService();
		const dispatcher = new ImageVariantJobDispatcher(
			repository,
			{ publish: jest.fn() } as unknown as ImageVariantJobPublisher,
			metrics,
		);

		try {
			dispatcher.onModuleInit();
			await new Promise((resolve) => setImmediate(resolve));

			expect(metrics.getMetrics().variantJobs).toEqual(
				expect.objectContaining({
					publishFailedTotal: 1,
					lastError: 'database unavailable',
				}),
			);
		} finally {
			dispatcher.onModuleDestroy();
			if (previousInterval === undefined) {
				delete process.env.IMAGE_VARIANT_OUTBOX_PUBLISH_INTERVAL_MS;
			} else {
				process.env.IMAGE_VARIANT_OUTBOX_PUBLISH_INTERVAL_MS = previousInterval;
			}
		}
	});

	it('generates a colocated filesystem variant and records the durable result', async () => {
		process.env.NODE_ENV = 'test';
		const repository = createRepository();
		const imageManager = {
			createPreGeneratedVariant: jest.fn().mockResolvedValue({
				name: 'sample__w400_hauto.webp',
				inputBytes: 100,
				outputBytes: 40,
				checksum: 'a'.repeat(64),
			}),
			getBufferImage: jest.fn().mockResolvedValue({
				name: 'sample__w400_hauto.webp',
				image: Buffer.from('variant'),
			}),
		};
		const metrics = new ImageLifecycleMetricsService();
		const worker = new ImageVariantJobWorker(
			{ kafkaClientBrokerList: [] } as unknown as AppConfig,
			imageManager as unknown as ImageManager,
			metrics,
			repository,
		);

		await worker.handlePayload(Buffer.from(JSON.stringify(job)));

		expect(repository.completeJob).toHaveBeenCalledWith(
			job,
			expect.objectContaining({
				name: 'sample__w400_hauto.webp',
				storageKey: 'products/image/sample__w400_hauto.webp',
				inputBytes: 100,
				outputBytes: 40,
				checksum: expect.any(String),
			}),
		);
		expect(repository.failJob).not.toHaveBeenCalled();
	});

	it('removes a generated variant when delete fencing rejects the durable result', async () => {
		process.env.NODE_ENV = 'test';
		const repository = createRepository();
		repository.completeJob.mockResolvedValue(false);
		const imageManager = {
			createPreGeneratedVariant: jest.fn().mockResolvedValue({
				name: 'sample__w400_hauto.webp',
				inputBytes: 100,
				outputBytes: 40,
				checksum: 'a'.repeat(64),
			}),
			getBufferImage: jest.fn().mockResolvedValue({
				name: 'sample__w400_hauto.webp',
				image: Buffer.from('variant'),
			}),
			deleteMainImage: jest.fn().mockResolvedValue(undefined),
		};
		const metrics = new ImageLifecycleMetricsService();
		const worker = new ImageVariantJobWorker(
			{ kafkaClientBrokerList: [] } as unknown as AppConfig,
			imageManager as unknown as ImageManager,
			metrics,
			repository,
		);

		await worker.handlePayload(Buffer.from(JSON.stringify(job)));

		expect(imageManager.deleteMainImage).toHaveBeenCalledWith({
			path: job.path,
			name: 'sample__w400_hauto.webp',
		});
		expect(metrics.getMetrics().variantJobs.completedTotal).toBe(0);
		expect(repository.failJob).not.toHaveBeenCalled();
	});

	it('preserves the delete lifecycle eventId in the invalidation event', async () => {
		const previousTopic = process.env.CACHE_INVALIDATION_KAFKA_TOPIC;
		process.env.CACHE_INVALIDATION_KAFKA_TOPIC =
			'custom.image.cache-invalidation.v1';
		const emit = jest.fn().mockReturnValue(of({ ok: true }));
		const publisher = new ImageCacheInvalidationPublisher(
			{ emit } as unknown as ClientKafka,
			new ImageLifecycleMetricsService(),
		);

		try {
			await publisher.publish({
				eventId: 'delete-event-1',
				clientServiceId: 'service-1',
				path: 'products',
				name: 'sample.png',
				reason: 'delete',
			});
		} finally {
			if (previousTopic === undefined) {
				delete process.env.CACHE_INVALIDATION_KAFKA_TOPIC;
			} else {
				process.env.CACHE_INVALIDATION_KAFKA_TOPIC = previousTopic;
			}
		}

		const payload = emit.mock.calls[0][1] as { value: string };
		expect(emit.mock.calls[0][0]).toBe('custom.image.cache-invalidation.v1');
		expect(JSON.parse(payload.value)).toEqual(
			expect.objectContaining({
				eventId: 'delete-event-1',
				reason: 'delete',
			}),
		);
	});

	it('commits the variant Kafka offset only after the durable job result', async () => {
		process.env.NODE_ENV = 'test';
		const repository = createRepository();
		const worker = new ImageVariantJobWorker(
			{ kafkaClientBrokerList: [] } as unknown as AppConfig,
			{
				createPreGeneratedVariant: jest.fn().mockResolvedValue({
					name: 'sample__w400_hauto.webp',
					inputBytes: 100,
					outputBytes: 40,
					checksum: 'a'.repeat(64),
				}),
				getBufferImage: jest.fn().mockResolvedValue({
					image: Buffer.from('variant'),
				}),
			} as unknown as ImageManager,
			new ImageLifecycleMetricsService(),
			repository,
		);
		const commitOffsets = jest.fn().mockResolvedValue(undefined);
		const internals = worker as unknown as {
			consumer: { commitOffsets: typeof commitOffsets };
			handleMessage(payload: unknown): Promise<void>;
		};
		internals.consumer = { commitOffsets };

		await internals.handleMessage({
			topic: 'file.image.variant.jobs.v1',
			partition: 0,
			message: {
				offset: '9',
				key: Buffer.from(job.jobKey),
				value: Buffer.from(JSON.stringify(job)),
			},
		});

		expect(repository.completeJob).toHaveBeenCalled();
		expect(commitOffsets).toHaveBeenCalledWith([
			{
				topic: 'file.image.variant.jobs.v1',
				partition: 0,
				offset: '10',
			},
		]);
	});

	it('does not perform request-time invalidation after the durable result', async () => {
		process.env.NODE_ENV = 'test';
		const repository = createRepository();
		const worker = new ImageVariantJobWorker(
			{ kafkaClientBrokerList: [] } as unknown as AppConfig,
			{
				createPreGeneratedVariant: jest.fn().mockResolvedValue({
					name: 'sample__w400_hauto.webp',
					inputBytes: 100,
					outputBytes: 40,
					checksum: 'a'.repeat(64),
				}),
				getBufferImage: jest.fn().mockResolvedValue({
					image: Buffer.from('variant'),
				}),
			} as unknown as ImageManager,
			new ImageLifecycleMetricsService(),
			repository,
		);

		await worker.handlePayload(Buffer.from(JSON.stringify(job)));

		expect(repository.completeJob).toHaveBeenCalled();
		expect(repository.failJob).not.toHaveBeenCalled();
	});
});
