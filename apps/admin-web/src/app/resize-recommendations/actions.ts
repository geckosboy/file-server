'use server';

import { revalidatePath } from 'next/cache';
import {
	TelemetryApiError,
	createClientServiceImageResizeVariant,
	fetchClientServiceImageResizePolicy,
	updateClientServiceImageResizePolicy,
	updateClientServiceImageResizeVariant,
	type ClientServiceImageResizeVariantItem,
	type ImageResizeFormat,
} from '@/lib/telemetry-api';

export interface ResizeRecommendationActionState {
	message?: string;
	error?: string;
}

export async function applyResizeRecommendationAction(
	_previousState: ResizeRecommendationActionState,
	formData: FormData,
): Promise<ResizeRecommendationActionState> {
	try {
		const serviceId = readRequiredFormString(formData, 'serviceId');
		const variantInput = {
			width: readOptionalPositiveInteger(formData, 'width'),
			height: readOptionalPositiveInteger(formData, 'height'),
			format: readImageResizeFormat(formData),
			isEnabled: true,
			description: buildRecommendationDescription(formData),
		};
		assertHasResizeDimension(variantInput);

		const policy = await fetchClientServiceImageResizePolicy(serviceId);
		await updateClientServiceImageResizePolicy(serviceId, {
			mode: 'PRE_GENERATE',
		});

		const existingVariant = policy.variants.find((variant) =>
			isSameVariant(variant, variantInput),
		);
		if (existingVariant) {
			await updateClientServiceImageResizeVariant(
				serviceId,
				existingVariant.id,
				{
					...variantInput,
					description: existingVariant.description ?? variantInput.description,
				},
			);
			revalidateRecommendationPaths();
			return {
				message:
					'기존 pre-generate variant를 활성화하고 정책 모드를 PRE_GENERATE로 저장했습니다.',
			};
		}

		await createClientServiceImageResizeVariant(serviceId, variantInput);
		revalidateRecommendationPaths();
		return {
			message: '추천 사이즈를 pre-generate 정책에 반영했습니다.',
		};
	} catch (error) {
		if (error instanceof TelemetryApiError && error.status === 409) {
			revalidateRecommendationPaths();
			return {
				message:
					'이미 동일한 pre-generate variant가 있어 정책 모드만 PRE_GENERATE로 저장했습니다.',
			};
		}

		return {
			error:
				error instanceof Error
					? error.message
					: '추천 정책 반영에 실패했습니다.',
		};
	}
}

function revalidateRecommendationPaths() {
	revalidatePath('/resize-recommendations');
	revalidatePath('/services');
}

function isSameVariant(
	variant: ClientServiceImageResizeVariantItem,
	input: { width?: number; height?: number; format: ImageResizeFormat },
) {
	return (
		variant.width === input.width &&
		variant.height === input.height &&
		variant.format === input.format
	);
}

function buildRecommendationDescription(formData: FormData) {
	const requestCount = readOptionalFormString(formData, 'requestCount');
	const savedMs = readOptionalFormString(formData, 'estimatedSavedResizeMs');
	const fragments = ['추천에서 반영'];
	if (requestCount) {
		fragments.push(`요청 ${requestCount}회`);
	}
	if (savedMs) {
		fragments.push(`예상 절감 ${savedMs}ms`);
	}
	return fragments.join(' · ');
}

function readRequiredFormString(formData: FormData, key: string) {
	const value = readOptionalFormString(formData, key);
	if (!value) {
		throw new Error(`${key} 값이 필요합니다.`);
	}
	return value;
}

function readOptionalFormString(formData: FormData, key: string) {
	const value = formData.get(key);
	return typeof value === 'string' && value.trim() !== ''
		? value.trim()
		: undefined;
}

function readImageResizeFormat(formData: FormData): ImageResizeFormat {
	const format = readRequiredFormString(formData, 'format');
	if (format !== 'png' && format !== 'jpeg' && format !== 'webp') {
		throw new Error('format은 png, jpeg, webp만 가능합니다.');
	}
	return format;
}

function readOptionalPositiveInteger(formData: FormData, key: string) {
	const value = readOptionalFormString(formData, key);
	if (value === undefined) {
		return undefined;
	}

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 10_000) {
		throw new Error(`${key}는 1~10000 사이의 정수여야 합니다.`);
	}
	return parsed;
}

function assertHasResizeDimension(input: { width?: number; height?: number }) {
	if (input.width === undefined && input.height === undefined) {
		throw new Error('width 또는 height 중 하나 이상이 필요합니다.');
	}
}
