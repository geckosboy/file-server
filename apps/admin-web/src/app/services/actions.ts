'use server';

import { revalidatePath } from 'next/cache';
import {
	createClientService,
	createClientServiceKey,
	createClientServicePolicy,
	createClientServiceImageResizeVariant,
	createClientServiceLifecycleSubscription,
	deleteClientServiceImageResizeVariant,
	deleteClientServicePolicy,
	fetchClientServiceDetailsList,
	revokeClientServiceKey,
	updateClientService,
	updateClientServicePolicy,
	updateClientServiceImageResizePolicy,
	updateClientServiceImageResizeVariant,
	updateClientServiceLifecycleSubscription,
	type ClientServiceItem,
	type ClientServiceStatus,
	type ImageResizeFormat,
	type ImageResizeMode,
	type LifecycleEventType,
} from '@/lib/telemetry-api';
import { requireAdminWebSession } from '@/lib/admin-session';

export interface GeneratedKeyNotice {
	serviceName: string;
	apiKey: string;
	keyPrefix: string;
}

export interface ServicesActionState {
	services: ClientServiceItem[];
	message?: string;
	error?: string;
	generatedKey?: GeneratedKeyNotice;
}

export async function submitClientServiceAction(
	previousState: ServicesActionState,
	formData: FormData,
): Promise<ServicesActionState> {
	try {
		await requireAdminWebSession();
		const intent = readRequiredFormString(formData, 'intent');
		const generatedKey = await runIntent(intent, formData);
		revalidatePath('/services');

		return {
			services: await fetchClientServiceDetailsList(),
			message: successMessage(intent),
			generatedKey,
		};
	} catch (error) {
		return {
			...previousState,
			error:
				error instanceof Error ? error.message : '요청 처리에 실패했습니다.',
			message: undefined,
			generatedKey: undefined,
		};
	}
}

async function runIntent(
	intent: string,
	formData: FormData,
): Promise<GeneratedKeyNotice | undefined> {
	if (intent === 'create-service') {
		await createClientService({
			slug: readRequiredFormString(formData, 'slug'),
			name: readRequiredFormString(formData, 'name'),
			description: readOptionalFormString(formData, 'description'),
			owner: readOptionalFormString(formData, 'owner'),
			status: readStatus(formData) ?? 'ACTIVE',
		});
		return undefined;
	}

	if (intent === 'update-service') {
		const serviceId = readRequiredFormString(formData, 'serviceId');
		await updateClientService(serviceId, {
			name: readRequiredFormString(formData, 'name'),
			description: readNullableFormString(formData, 'description'),
			owner: readNullableFormString(formData, 'owner'),
			status: readStatus(formData),
		});
		return undefined;
	}

	if (intent === 'create-key') {
		const serviceId = readRequiredFormString(formData, 'serviceId');
		const serviceName = readRequiredFormString(formData, 'serviceName');
		const result = await createClientServiceKey(serviceId, {
			name: readOptionalFormString(formData, 'keyName'),
			scopes: readScopes(formData),
			expiresAt: readOptionalDateTime(formData, 'expiresAt'),
		});
		return {
			serviceName,
			apiKey: result.apiKey,
			keyPrefix: result.key.keyPrefix,
		};
	}

	if (intent === 'create-access-policy') {
		await createClientServicePolicy(
			readRequiredFormString(formData, 'serviceId'),
			{
				pathPattern: readRequiredFormString(formData, 'pathPattern'),
				canRead: readEnabledField(formData, 'canRead'),
				canUpload: readEnabledField(formData, 'canUpload'),
				canDelete: readEnabledField(formData, 'canDelete'),
				maxUploadBytes: readOptionalPolicyInteger(formData, 'maxUploadBytes'),
				rateLimitPerMin: readOptionalPolicyInteger(formData, 'rateLimitPerMin'),
				metadata: readOptionalJsonObject(formData, 'metadata'),
			},
		);
		return undefined;
	}

	if (intent === 'update-access-policy') {
		await updateClientServicePolicy(
			readRequiredFormString(formData, 'serviceId'),
			readRequiredFormString(formData, 'policyId'),
			{
				pathPattern: readRequiredFormString(formData, 'pathPattern'),
				canRead: readEnabledField(formData, 'canRead'),
				canUpload: readEnabledField(formData, 'canUpload'),
				canDelete: readEnabledField(formData, 'canDelete'),
				maxUploadBytes: readNullablePolicyInteger(formData, 'maxUploadBytes'),
				rateLimitPerMin: readNullablePolicyInteger(formData, 'rateLimitPerMin'),
				metadata: readNullableJsonObject(formData, 'metadata'),
			},
		);
		return undefined;
	}

	if (intent === 'delete-access-policy') {
		await deleteClientServicePolicy(
			readRequiredFormString(formData, 'serviceId'),
			readRequiredFormString(formData, 'policyId'),
		);
		return undefined;
	}

	if (intent === 'create-lifecycle-subscription') {
		await createClientServiceLifecycleSubscription(
			readRequiredFormString(formData, 'serviceId'),
			{
				eventType: readLifecycleEventType(formData),
				consumerGroup: readRequiredFormString(formData, 'consumerGroup'),
				isEnabled: readEnabled(formData),
				description: readOptionalFormString(formData, 'description'),
			},
		);
		return undefined;
	}

	if (intent === 'update-lifecycle-subscription') {
		await updateClientServiceLifecycleSubscription(
			readRequiredFormString(formData, 'serviceId'),
			readRequiredFormString(formData, 'subscriptionId'),
			{
				eventType: readLifecycleEventType(formData),
				consumerGroup: readRequiredFormString(formData, 'consumerGroup'),
				isEnabled: readEnabled(formData),
				description: readNullableFormString(formData, 'description'),
			},
		);
		return undefined;
	}

	if (intent === 'update-image-resize-policy') {
		await updateClientServiceImageResizePolicy(
			readRequiredFormString(formData, 'serviceId'),
			{
				mode: readImageResizeMode(formData),
			},
		);
		return undefined;
	}

	if (intent === 'create-image-resize-variant') {
		const input = {
			width: readOptionalPositiveInteger(formData, 'width'),
			height: readOptionalPositiveInteger(formData, 'height'),
			format: readImageResizeFormat(formData),
			isEnabled: readEnabled(formData),
			description: readOptionalFormString(formData, 'description'),
		};
		assertHasResizeDimension(input);
		await createClientServiceImageResizeVariant(
			readRequiredFormString(formData, 'serviceId'),
			input,
		);
		return undefined;
	}

	if (intent === 'update-image-resize-variant') {
		const input = {
			width: readOptionalPositiveInteger(formData, 'width'),
			height: readOptionalPositiveInteger(formData, 'height'),
			format: readImageResizeFormat(formData),
			isEnabled: readEnabled(formData),
			description: readNullableFormString(formData, 'description'),
		};
		assertHasResizeDimension(input);
		await updateClientServiceImageResizeVariant(
			readRequiredFormString(formData, 'serviceId'),
			readRequiredFormString(formData, 'variantId'),
			input,
		);
		return undefined;
	}

	if (intent === 'delete-image-resize-variant') {
		await deleteClientServiceImageResizeVariant(
			readRequiredFormString(formData, 'serviceId'),
			readRequiredFormString(formData, 'variantId'),
		);
		return undefined;
	}

	if (intent === 'revoke-key') {
		await revokeClientServiceKey(
			readRequiredFormString(formData, 'serviceId'),
			readRequiredFormString(formData, 'keyId'),
		);
		return undefined;
	}

	throw new Error('알 수 없는 서비스 관리 요청입니다.');
}

function successMessage(intent: string) {
	if (intent === 'create-service') {
		return '서비스를 등록했습니다.';
	}
	if (intent === 'update-service') {
		return '서비스 정보를 저장했습니다.';
	}
	if (intent === 'create-key') {
		return 'API key를 발급했습니다. 원문은 지금 한 번만 표시됩니다.';
	}
	if (intent === 'create-access-policy') {
		return '접근 정책을 등록했습니다.';
	}
	if (intent === 'update-access-policy') {
		return '접근 정책을 저장했습니다.';
	}
	if (intent === 'delete-access-policy') {
		return '접근 정책을 삭제했습니다.';
	}
	if (intent === 'create-lifecycle-subscription') {
		return 'lifecycle subscription을 등록했습니다.';
	}
	if (intent === 'update-lifecycle-subscription') {
		return 'lifecycle subscription을 저장했습니다.';
	}
	if (intent === 'update-image-resize-policy') {
		return '이미지 리사이징 정책을 저장했습니다.';
	}
	if (intent === 'create-image-resize-variant') {
		return '사전 생성 사이즈를 추가했습니다.';
	}
	if (intent === 'update-image-resize-variant') {
		return '사전 생성 사이즈를 저장했습니다.';
	}
	if (intent === 'delete-image-resize-variant') {
		return '사전 생성 사이즈를 삭제했습니다.';
	}
	if (intent === 'revoke-key') {
		return 'API key를 폐기했습니다.';
	}
	return '요청을 처리했습니다.';
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

function readNullableFormString(formData: FormData, key: string) {
	return readOptionalFormString(formData, key) ?? null;
}

function readStatus(formData: FormData): ClientServiceStatus | undefined {
	const status = readOptionalFormString(formData, 'status');
	if (status === undefined) {
		return undefined;
	}
	if (status !== 'ACTIVE' && status !== 'DISABLED') {
		throw new Error('status는 ACTIVE 또는 DISABLED만 가능합니다.');
	}
	return status;
}

function readLifecycleEventType(formData: FormData): LifecycleEventType {
	const eventType = readRequiredFormString(formData, 'eventType');
	if (
		eventType !== 'image.upload.completed' &&
		eventType !== 'image.upload.failed'
	) {
		throw new Error(
			'eventType은 image.upload.completed 또는 image.upload.failed만 가능합니다.',
		);
	}
	return eventType;
}

function readEnabled(formData: FormData) {
	const value = readRequiredFormString(formData, 'isEnabled');
	if (value !== 'true' && value !== 'false') {
		throw new Error('활성화 여부는 true 또는 false만 가능합니다.');
	}
	return value === 'true';
}

function readEnabledField(formData: FormData, key: string) {
	const value = readRequiredFormString(formData, key);
	if (value !== 'true' && value !== 'false') {
		throw new Error(`${key} 값은 true 또는 false여야 합니다.`);
	}
	return value === 'true';
}

function readImageResizeMode(formData: FormData): ImageResizeMode {
	const mode = readRequiredFormString(formData, 'mode');
	if (mode !== 'ON_DEMAND' && mode !== 'PRE_GENERATE') {
		throw new Error('mode는 ON_DEMAND 또는 PRE_GENERATE만 가능합니다.');
	}
	return mode;
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

function readOptionalPolicyInteger(formData: FormData, key: string) {
	const value = readOptionalFormString(formData, key);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
		throw new Error(`${key}는 양의 32-bit 정수여야 합니다.`);
	}
	return parsed;
}

function readNullablePolicyInteger(formData: FormData, key: string) {
	return readOptionalFormString(formData, key) === undefined
		? null
		: readOptionalPolicyInteger(formData, key);
}

function readOptionalJsonObject(formData: FormData, key: string) {
	const raw = readOptionalFormString(formData, key);
	if (!raw) return undefined;
	const parsed = JSON.parse(raw) as unknown;
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${key}는 JSON object 형태여야 합니다.`);
	}
	return parsed as Record<string, unknown>;
}

function readNullableJsonObject(formData: FormData, key: string) {
	return readOptionalJsonObject(formData, key) ?? null;
}

function assertHasResizeDimension(input: { width?: number; height?: number }) {
	if (input.width === undefined && input.height === undefined) {
		throw new Error('width 또는 height 중 하나 이상이 필요합니다.');
	}
}

function readScopes(formData: FormData) {
	const raw = readOptionalFormString(formData, 'scopes');
	if (!raw) {
		return undefined;
	}

	const parsed = JSON.parse(raw) as unknown;
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('scopes는 JSON object 형태여야 합니다.');
	}
	return parsed as Record<string, unknown>;
}

function readOptionalDateTime(formData: FormData, key: string) {
	const value = readOptionalFormString(formData, key);
	if (!value) {
		return undefined;
	}
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) {
		throw new Error(`${key}는 유효한 날짜여야 합니다.`);
	}
	return date.toISOString();
}
