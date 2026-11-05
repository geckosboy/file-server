import { Test } from '@nestjs/testing';
import { ImageAssetMetadataRepository, PrismaService } from '@file/database';
import {
	IMAGE_ASSET_LIFECYCLE_METADATA,
	IMAGE_CACHE_INVALIDATION_PORT,
	ImageAssetLifecycleService,
} from '../image-asset-lifecycle.service';
import { ImageReconciliationScheduler } from '../image-reconciliation.scheduler';
import { IMAGE_RECONCILIATION_METRICS_SOURCE } from '../image-lifecycle-health.service';
import { IMAGE_VARIANT_JOB_REPOSITORY } from '../image-variant-job.repository';

describe('ImageModule lifecycle wiring', () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('compiles and resolves every lifecycle/job/reconciliation token', async () => {
		process.env.NODE_ENV = 'test';
		process.env.PORT = '3032';
		process.env.ORIGIN_LIST_STR = 'http://localhost:3000';
		process.env.INTERNAL_API_KEY = 'test-internal-key';
		process.env.KAFKA_CLIENT_BROKERS = 'localhost:9092';
		process.env.DATABASE_URL =
			'postgresql://file_server:file_server@localhost:5432/file_server';
		process.env.CLIENT_API_KEY_PEPPER = 'test-pepper';
		process.env.IMAGE_RECONCILIATION_ENABLED = 'false';
		process.env.IMAGE_VARIANT_KAFKA_ENABLED = 'false';
		process.env.IMAGE_VARIANT_OUTBOX_PUBLISH_INTERVAL_MS = '0';
		process.env.LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS = '0';
		process.env.LIFECYCLE_OUTBOX_CLEANUP_INTERVAL_MS = '0';
		const [{ ConfigModule }, { ImageModule }] = await Promise.all([
			import('../../../config'),
			import('../image.module'),
		]);
		const moduleRef = await Test.createTestingModule({
			imports: [ConfigModule, ImageModule],
		})
			.overrideProvider(PrismaService)
			.useValue({})
			.overrideProvider(ImageAssetMetadataRepository)
			.useValue({})
			.compile();

		await moduleRef.init();
		expect(moduleRef.get(ImageAssetLifecycleService)).toBeDefined();
		expect(moduleRef.get(ImageReconciliationScheduler)).toBeDefined();
		expect(moduleRef.get(IMAGE_ASSET_LIFECYCLE_METADATA)).toBeDefined();
		expect(moduleRef.get(IMAGE_CACHE_INVALIDATION_PORT)).toBeDefined();
		expect(moduleRef.get(IMAGE_VARIANT_JOB_REPOSITORY)).toBeDefined();
		expect(moduleRef.get(IMAGE_RECONCILIATION_METRICS_SOURCE)).toBeDefined();
		await moduleRef.close();
	});
});
