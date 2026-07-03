import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@file/database';
import { performance } from 'perf_hooks';
import {
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
