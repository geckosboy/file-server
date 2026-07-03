'use server';

import { revalidatePath } from 'next/cache';
import {
	createClientService,
	createClientServiceKey,
	fetchClientServiceDetailsList,
	revokeClientServiceKey,
	updateClientService,
	type ClientServiceItem,
	type ClientServiceStatus,
} from '@/lib/telemetry-api';

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
