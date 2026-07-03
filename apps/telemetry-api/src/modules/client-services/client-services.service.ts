import {
	BadRequestException,
	ConflictException,
	Inject,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { generateClientApiKey } from '@file/database';
import {
	ClientServiceLifecycleEventType,
	ClientServiceStatus,
	CreateClientServiceLifecycleSubscriptionInput,
	CreateClientServiceInput,
	CreateClientServiceKeyInput,
	CreateClientServiceKeyResult,
	JsonObject,
	UpdateClientServiceLifecycleSubscriptionInput,
	UpdateClientServiceInput,
} from './client-services.types';
import {
	ClientServiceKeyNotFoundError,
	ClientServiceLifecycleSubscriptionNotFoundError,
	ClientServiceNotFoundError,
	ClientServicesRepository,
	DuplicateClientServiceLifecycleSubscriptionError,
	DuplicateClientServiceSlugError,
} from './client-services.repository';
import { CLIENT_SERVICES_REPOSITORY } from './client-services-repository.provider';

const SERVICE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CONSUMER_GROUP_PATTERN = /^[A-Za-z0-9._-]{2,128}$/;

@Injectable()
export class ClientServicesService {
	constructor(
		@Inject(CLIENT_SERVICES_REPOSITORY)
		private readonly repository: ClientServicesRepository,
	) {}

	listServices() {
		return this.repository.listServices();
	}

	async getService(id: string) {
		const service = await this.repository.findServiceById(id);
		if (!service) {
			throw new NotFoundException('client service not found');
		}
		return service;
	}

	async createService(payload: unknown) {
		const input = parseCreateServiceInput(payload);
		try {
			return await this.repository.createService(input);
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async updateService(id: string, payload: unknown) {
		const input = parseUpdateServiceInput(payload);
		try {
			return await this.repository.updateService(id, input);
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async createKey(
		clientServiceId: string,
		payload: unknown,
	): Promise<CreateClientServiceKeyResult> {
		const input = parseCreateKeyInput(payload);
		const generated = generateClientApiKey();
		try {
			const key = await this.repository.createKey({
				clientServiceId,
				name: input.name,
				keyPrefix: generated.keyPrefix,
				keyHash: generated.keyHash,
				scopes: input.scopes,
				expiresAt: input.expiresAt,
			});
			return { apiKey: generated.apiKey, key };
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async revokeKey(clientServiceId: string, keyId: string) {
		try {
			return await this.repository.revokeKey({
				clientServiceId,
				keyId,
				revokedAt: new Date().toISOString(),
			});
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async createLifecycleSubscription(clientServiceId: string, payload: unknown) {
		const input = parseCreateLifecycleSubscriptionInput(payload);
		try {
			return await this.repository.createLifecycleSubscription({
				clientServiceId,
				...input,
				isEnabled: input.isEnabled ?? true,
			});
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async updateLifecycleSubscription(
		clientServiceId: string,
		subscriptionId: string,
		payload: unknown,
	) {
		const input = parseUpdateLifecycleSubscriptionInput(payload);
		try {
			return await this.repository.updateLifecycleSubscription({
				clientServiceId,
				subscriptionId,
				...input,
			});
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}
}

function parseCreateServiceInput(
	payload: unknown,
): CreateClientServiceInput & { status: ClientServiceStatus } {
	const record = requireRecord(payload);
	const slug = readRequiredString(record, 'slug');
	const name = readRequiredString(record, 'name');
	assertServiceSlug(slug);

	return {
		slug,
		name,
		description: readOptionalString(record, 'description'),
		owner: readOptionalString(record, 'owner'),
		status: readOptionalStatus(record, 'status') ?? ClientServiceStatus.Active,
	};
}

function parseUpdateServiceInput(payload: unknown): UpdateClientServiceInput {
	const record = requireRecord(payload);
	const slug = readOptionalString(record, 'slug');
	if (slug !== undefined) {
		assertServiceSlug(slug);
	}

	const input: UpdateClientServiceInput = {
		slug,
		name: readOptionalString(record, 'name'),
		description: readNullableString(record, 'description'),
		owner: readNullableString(record, 'owner'),
		status: readOptionalStatus(record, 'status'),
	};

	if (Object.values(input).every((value) => value === undefined)) {
		throw new BadRequestException('수정할 필드가 필요합니다');
	}

	return input;
}

function parseCreateKeyInput(payload: unknown): CreateClientServiceKeyInput {
	const record = requireRecord(payload ?? {});
	const expiresAt = readOptionalIsoString(record, 'expiresAt');
	return {
		name: readOptionalString(record, 'name'),
		scopes: readOptionalJsonObject(record, 'scopes'),
		expiresAt,
	};
}

function parseCreateLifecycleSubscriptionInput(
	payload: unknown,
): CreateClientServiceLifecycleSubscriptionInput {
	const record = requireRecord(payload);
	const eventType = readRequiredLifecycleEventType(record, 'eventType');
	const consumerGroup = readRequiredString(record, 'consumerGroup');
	assertConsumerGroup(consumerGroup);

	return {
		eventType,
		consumerGroup,
		isEnabled: readOptionalBoolean(record, 'isEnabled'),
		description: readOptionalString(record, 'description'),
	};
}

function parseUpdateLifecycleSubscriptionInput(
	payload: unknown,
): UpdateClientServiceLifecycleSubscriptionInput {
	const record = requireRecord(payload);
	const eventType = readOptionalLifecycleEventType(record, 'eventType');
	const consumerGroup = readOptionalString(record, 'consumerGroup');
	if (consumerGroup !== undefined) {
		assertConsumerGroup(consumerGroup);
	}

	const input: UpdateClientServiceLifecycleSubscriptionInput = {
		eventType,
		consumerGroup,
		isEnabled: readOptionalBoolean(record, 'isEnabled'),
		description: readNullableString(record, 'description'),
	};

	if (Object.values(input).every((value) => value === undefined)) {
		throw new BadRequestException('수정할 필드가 필요합니다');
	}

	return input;
}

function requireRecord(payload: unknown): Record<string, unknown> {
	if (
		typeof payload !== 'object' ||
		payload === null ||
		Array.isArray(payload)
	) {
		throw new BadRequestException('payload must be an object');
	}
	return payload as Record<string, unknown>;
}

function readRequiredString(
	record: Record<string, unknown>,
	key: string,
): string {
	const value = readOptionalString(record, key);
	if (!value) {
		throw new BadRequestException(`${key} is required`);
	}
	return value;
}

function readOptionalString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || value.trim() === '') {
		throw new BadRequestException(`${key} must be a non-empty string`);
	}
	return value.trim();
}

function readNullableString(
	record: Record<string, unknown>,
	key: string,
): string | null | undefined {
	return record[key] === null ? null : readOptionalString(record, key);
}

function readOptionalStatus(
	record: Record<string, unknown>,
	key: string,
): ClientServiceStatus | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (
		!Object.values(ClientServiceStatus).includes(value as ClientServiceStatus)
	) {
		throw new BadRequestException(`${key} must be ACTIVE or DISABLED`);
	}
	return value as ClientServiceStatus;
}

function readRequiredLifecycleEventType(
	record: Record<string, unknown>,
	key: string,
): ClientServiceLifecycleEventType {
	const value = readOptionalLifecycleEventType(record, key);
	if (!value) {
		throw new BadRequestException(`${key} is required`);
	}
	return value;
}

function readOptionalLifecycleEventType(
	record: Record<string, unknown>,
	key: string,
): ClientServiceLifecycleEventType | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (
		!Object.values(ClientServiceLifecycleEventType).includes(
			value as ClientServiceLifecycleEventType,
		)
	) {
		throw new BadRequestException(
			`${key} must be image.upload.completed or image.upload.failed`,
		);
	}
	return value as ClientServiceLifecycleEventType;
}

function readOptionalBoolean(
	record: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'boolean') {
		throw new BadRequestException(`${key} must be a boolean`);
	}
	return value;
}

function readOptionalIsoString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = readOptionalString(record, key);
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isFinite(new Date(value).getTime())) {
		throw new BadRequestException(`${key} must be an ISO date string`);
	}
	return value;
}

function readOptionalJsonObject(
	record: Record<string, unknown>,
	key: string,
): JsonObject | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new BadRequestException(`${key} must be an object`);
	}
	return value as JsonObject;
}

function assertServiceSlug(slug: string): void {
	if (!SERVICE_SLUG_PATTERN.test(slug)) {
		throw new BadRequestException(
			'slug는 소문자/숫자/하이픈 2~63자로 입력해야 합니다',
		);
	}
}

function assertConsumerGroup(consumerGroup: string): void {
	if (!CONSUMER_GROUP_PATTERN.test(consumerGroup)) {
		throw new BadRequestException(
			'consumerGroup은 영문/숫자/점/밑줄/하이픈 2~128자로 입력해야 합니다',
		);
	}
}

function mapRepositoryError(error: unknown): Error {
	if (error instanceof DuplicateClientServiceSlugError) {
		return new ConflictException('client service slug already exists');
	}
	if (error instanceof DuplicateClientServiceLifecycleSubscriptionError) {
		return new ConflictException(
			'client service lifecycle subscription already exists',
		);
	}
	if (error instanceof ClientServiceNotFoundError) {
		return new NotFoundException('client service not found');
	}
	if (error instanceof ClientServiceKeyNotFoundError) {
		return new NotFoundException('client service key not found');
	}
	if (error instanceof ClientServiceLifecycleSubscriptionNotFoundError) {
		return new NotFoundException(
			'client service lifecycle subscription not found',
		);
	}
	return error instanceof Error ? error : new Error('unknown repository error');
}
