import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@file/database';
import { performance } from 'perf_hooks';
import {
	createPreGeneratedVariantName,
	ImageManager,
	type PreGeneratedImageFormat,
} from './strategies/manager';

const PRE_GENERATE_MODE = 'PRE_GENERATE';

export interface ImagePregenerationUploadInfo {
	clientServiceId?: string;
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

export interface PreGeneratedVariantLookupInfo {
	clientServiceId?: string;
	path: string;
	name: string;
	width?: number;
	height?: number;
	format?: PreGeneratedImageFormat;
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
	) {}

	async preGenerateForUpload(
		info: ImagePregenerationUploadInfo,
	): Promise<ImagePregenerationResult[]> {
		if (!info.clientServiceId) {
			return [];
		}

		const policy = await this.loadActivePreGeneratePolicy(info.clientServiceId);
		if (!policy) {
			return [];
		}

		const results: ImagePregenerationResult[] = [];
		for (const variant of policy.variants) {
			const normalizedVariant = normalizeVariant(variant);
			if (!normalizedVariant) {
				this.logger.warn(
					`지원하지 않는 사전 리사이징 format입니다: ${variant.format}`,
				);
				continue;
			}

			const startedAt = performance.now();
			try {
				const generated = await this.imageManager.createPreGeneratedVariant({
					path: info.path,
					name: info.name,
					width: normalizedVariant.width,
					height: normalizedVariant.height,
					format: normalizedVariant.format,
				});
				results.push({
					...normalizedVariant,
					variantName: generated.name,
					inputBytes: generated.inputBytes,
					outputBytes: generated.outputBytes,
					durationMs: performance.now() - startedAt,
					status: 'success',
				});
			} catch (error) {
				this.logger.warn(
					`사전 리사이징 생성 실패: ${info.path}/${info.name} ${variant.width ?? 'auto'}x${variant.height ?? 'auto'} ${variant.format}`,
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

		const variantName = createPreGeneratedVariantName({
			name: info.name,
			width: variant.width,
			height: variant.height,
			format: variant.format,
		});

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
