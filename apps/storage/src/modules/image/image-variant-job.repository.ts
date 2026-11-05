import { ImageVariantJobEvent } from '@file/telemetry-contracts/image-operations';

export const IMAGE_VARIANT_JOB_REPOSITORY = Symbol(
	'IMAGE_VARIANT_JOB_REPOSITORY',
);

export interface ReadyImageAssetForVariants {
	assetId: string;
	clientServiceId: string;
	path: string;
	name: string;
	sourceChecksum: string;
	variants: Array<{
		width?: number;
		height?: number;
		format: ImageVariantJobEvent['format'];
	}>;
}

export interface CompletedImageVariant {
	name: string;
	storageKey: string;
	inputBytes: number;
	outputBytes: number;
	checksum?: string;
}

export interface ImageVariantJobRepository {
	createPendingJobs(
		asset: ReadyImageAssetForVariants,
	): Promise<ImageVariantJobEvent[]>;
	listPublishableJobs(limit: number): Promise<ImageVariantJobEvent[]>;
	recordPublished(jobKey: string): Promise<void>;
	recordPublishFailure(jobKey: string, error: unknown): Promise<void>;
	claimJob(
		job: ImageVariantJobEvent,
	): Promise<'claimed' | 'duplicate' | 'discarded' | 'unavailable'>;
	completeJob(
		job: ImageVariantJobEvent,
		result: CompletedImageVariant,
	): Promise<boolean>;
	failJob(job: ImageVariantJobEvent, error: unknown): Promise<void>;
}
