import {
	Inject,
	Injectable,
	Logger,
	NotFoundException,
	Optional,
} from '@nestjs/common';
import { PrismaService, createImageVariantSpecKey } from '@file/database';
import { createImageVariantJobEvent } from '@file/telemetry-contracts/image-operations';
import { ImageAssetState, ImageVariantState } from '@prisma/client';
import { splitAndNormalizeImageKey } from '@file/image-contracts';
import { performance } from 'perf_hooks';
import {
	createPreGeneratedVariantName,
	ImageManager,
	type PreGeneratedImageFormat,
} from './strategies/manager';
import {
	IMAGE_VARIANT_JOB_REPOSITORY,
	ImageVariantJobRepository,
} from './image-variant-job.repository';

const PRE_GENERATE_MODE = 'PRE_GENERATE';

export interface ImagePregenerationUploadInfo {
	clientServiceId?: string;
	assetId?: string;
	sourceChecksum?: string;
	path: string;
	name: string;
}

export interface ImagePregenerationResult {
	variantId: string;
	width?: number;
	height?: number;
	format: PreGeneratedImageFormat;
	variantName?: string;
	inputBytes?: number;
	outputBytes?: number;
	durationMs: number;
	status: 'success' | 'failed';
	error?: unknown;
}

export type ImagePregenerationSpec = Pick<
	ImagePregenerationResult,
	'variantId' | 'width' | 'height' | 'format'
>;

export interface PreGeneratedVariantLookupInfo {
	clientServiceId?: string;
	path: string;
	name: string;
	width?: number;
	height?: number;
	format?: PreGeneratedImageFormat;
	authoritativeAsset?: AuthoritativeImageRead;
}

export interface AuthoritativeImageRead {
	assetId: string;
	sourceChecksum?: string;
}

export interface PreGeneratedVariantLookupResult {
	image: Buffer;
	name: string;
	width?: number;
	height?: number;
	format: PreGeneratedImageFormat;
}

@Injectable()
export class ImagePregenerationService {
	private readonly logger = new Logger(ImagePregenerationService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly imageManager: ImageManager,
		@Optional()
		@Inject(IMAGE_VARIANT_JOB_REPOSITORY)
		private readonly variantJobs?: ImageVariantJobRepository,
	) {}

	async preGenerateForUpload(
		info: ImagePregenerationUploadInfo,
	): Promise<ImagePregenerationResult[]> {
		if (!info.clientServiceId) {
			return [];
		}

		const variants = await this.listActiveVariantSpecs(info.clientServiceId);
		if (!variants.length) {
			return [];
		}

		const results: ImagePregenerationResult[] = [];
		for (const normalizedVariant of variants) {
			const startedAt = performance.now();
			const job =
				this.variantJobs && info.assetId && info.sourceChecksum
					? createImageVariantJobEvent({
							assetId: info.assetId,
							clientServiceId: info.clientServiceId,
							path: info.path,
							name: info.name,
							sourceChecksum: info.sourceChecksum,
							width: normalizedVariant.width,
							height: normalizedVariant.height,
							format: normalizedVariant.format,
						})
					: undefined;
			let claimed = false;
			try {
				if (job && this.variantJobs) {
					const claim = await this.variantJobs.claimJob(job);
					if (claim === 'duplicate') {
						results.push({
							...normalizedVariant,
							variantName: createPreGeneratedVariantName({
								name: info.name,
								path: info.path,
								width: normalizedVariant.width,
								height: normalizedVariant.height,
								format: normalizedVariant.format,
							}),
							durationMs: performance.now() - startedAt,
							status: 'success',
						});
						continue;
					}
					if (claim === 'discarded') {
						throw new Error(`variant job is terminal: ${job.jobKey}`);
					}
					if (claim !== 'claimed') {
						throw new Error(`variant job is not claimable: ${job.jobKey}`);
					}
					claimed = true;
				}
				const generated = await this.imageManager.createPreGeneratedVariant({
					path: info.path,
					name: info.name,
					width: normalizedVariant.width,
					height: normalizedVariant.height,
					format: normalizedVariant.format,
				});
				if (job && this.variantJobs) {
					const completed = await this.variantJobs.completeJob(job, {
						name: generated.name,
						storageKey: `${info.path}/${generated.name}`,
						inputBytes: generated.inputBytes,
						outputBytes: generated.outputBytes,
						checksum: generated.checksum,
					});
					if (!completed) {
						await this.imageManager.deleteMainImage({
							path: info.path,
							name: generated.name,
						});
						throw new Error(`variant job was fenced: ${job.jobKey}`);
					}
				}
				results.push({
					...normalizedVariant,
					variantName: generated.name,
					inputBytes: generated.inputBytes,
					outputBytes: generated.outputBytes,
					durationMs: performance.now() - startedAt,
					status: 'success',
				});
			} catch (error) {
				if (claimed && job && this.variantJobs) {
					await this.variantJobs.failJob(job, error).catch(() => undefined);
				}
				this.logger.warn(
					`사전 리사이징 생성 실패: ${info.path}/${info.name} ${normalizedVariant.width ?? 'auto'}x${normalizedVariant.height ?? 'auto'} ${normalizedVariant.format}`,
				);
				results.push({
					...normalizedVariant,
					durationMs: performance.now() - startedAt,
					status: 'failed',
					error,
				});
			}
		}

		return results;
	}

	async listActiveVariantSpecs(clientServiceId: string) {
		const policy = await this.loadActivePreGeneratePolicy(clientServiceId);
		if (!policy) return [];
		return policy.variants.flatMap((variant) => {
			const normalized = normalizeVariant(variant);
			if (normalized) return [normalized];
			this.logger.warn(
				`지원하지 않는 사전 리사이징 format입니다: ${variant.format}`,
			);
			return [];
		});
	}

	async assertSourceReadable(info: {
		clientServiceId: string;
		path: string;
		name: string;
	}): Promise<AuthoritativeImageRead | null> {
		const asset = await this.prisma.imageAsset.findUnique({
			where: {
				clientServiceId_logicalPath_name: {
					clientServiceId: info.clientServiceId,
					logicalPath: info.path,
					name: info.name,
				},
			},
			select: { assetId: true, checksum: true, status: true },
		});
		if (!asset) {
			if (process.env.IMAGE_ASSET_DUAL_READ_ENABLED !== 'false') return null;
			throw imageUnavailable();
		}
		if (asset.status !== ImageAssetState.Ready) throw imageUnavailable();
		return {
			assetId: asset.assetId,
			sourceChecksum: asset.checksum ?? undefined,
		};
	}

	async findPreGeneratedVariantForRequest(
		info: PreGeneratedVariantLookupInfo,
	): Promise<PreGeneratedVariantLookupResult | null> {
		if (
			!info.clientServiceId ||
			!info.format ||
			(info.width === undefined && info.height === undefined)
		) {
			return null;
		}

		const policy = await this.loadActivePreGeneratePolicy(info.clientServiceId);
		const variant = policy?.variants
			.map(normalizeVariant)
			.find(
				(item) =>
					item &&
					item.width === info.width &&
					item.height === info.height &&
					item.format === info.format,
			);
		if (!variant) {
			return null;
		}

		let variantName = createPreGeneratedVariantName({
			name: info.name,
			path: info.path,
			width: variant.width,
			height: variant.height,
			format: variant.format,
		});
		if (info.authoritativeAsset) {
			if (!info.authoritativeAsset.sourceChecksum) return null;
			const readyVariant = await this.prisma.imageVariant.findFirst({
				where: {
					assetId: info.authoritativeAsset.assetId,
					specKey: createImageVariantSpecKey({
						width: variant.width,
						height: variant.height,
						format: variant.format,
						sourceChecksum: info.authoritativeAsset.sourceChecksum,
					}),
					sourceChecksum: info.authoritativeAsset.sourceChecksum,
					status: ImageVariantState.Ready,
				},
				select: { storageKey: true },
			});
			if (!readyVariant) return null;
			const target = splitAndNormalizeImageKey(readyVariant.storageKey);
			if (target.path !== info.path) return null;
			variantName = target.name;
		}

		try {
			const result = await this.imageManager.getBufferImage({
				path: info.path,
				name: variantName,
			});
			return {
				image: result.image,
				name: result.name,
				width: variant.width,
				height: variant.height,
				format: variant.format,
			};
		} catch (error) {
			this.logger.warn(
				`사전 리사이징 파일 조회 실패, 기존 조회 흐름으로 fallback합니다: ${info.path}/${variantName} ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		}
	}

	private async loadActivePreGeneratePolicy(clientServiceId: string) {
		try {
			const policy =
				await this.prisma.clientServiceImageResizePolicy.findUnique({
					where: { clientServiceId },
					include: {
						variants: {
							where: { isEnabled: true },
							orderBy: [{ width: 'asc' }, { height: 'asc' }, { format: 'asc' }],
						},
					},
				});

			if (!policy || policy.mode !== PRE_GENERATE_MODE) {
				return null;
			}

			return policy;
		} catch (error) {
			this.logger.warn(
				`사전 리사이징 정책 조회 실패: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}
}

const imageUnavailable = () =>
	new NotFoundException('파일이 존재하지 않거나 준비되지 않은 상태입니다.');

function normalizeVariant(variant: {
	id: string;
	width?: number | null;
	height?: number | null;
	format: string;
}): {
	variantId: string;
	width?: number;
	height?: number;
	format: PreGeneratedImageFormat;
} | null {
	if (!isPreGeneratedImageFormat(variant.format)) {
		return null;
	}

	return {
		variantId: variant.id,
		width: variant.width ?? undefined,
		height: variant.height ?? undefined,
		format: variant.format,
	};
}

function isPreGeneratedImageFormat(
	format: string,
): format is PreGeneratedImageFormat {
	return format === 'png' || format === 'jpeg' || format === 'webp';
}
