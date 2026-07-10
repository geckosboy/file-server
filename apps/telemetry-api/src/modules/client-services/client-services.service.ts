import {
	BadRequestException,
	ConflictException,
	Inject,
	Injectable,
	NotFoundException,
	Optional,
} from '@nestjs/common';
import { generateClientApiKey } from '@file/database';
import { normalizeClientServicePathPattern } from '@file/image-contracts';
import {
	createClientLifecyclePrincipal,
	createClientLifecycleTopic,
} from '@file/telemetry-contracts/lifecycle-topics';
import {
	AdminActionContext,
	ClientServiceImageResizeFormat,
	ClientServiceImageResizeMode,
	ClientServiceLifecycleEventType,
	ClientServiceLifecycleProvisioningRecord,
	ClientServiceLifecycleProvisioningStatus,
	ClientServiceStatus,
	CreateClientServiceImageResizeVariantInput,
	CreateClientServiceLifecycleSubscriptionInput,
	CreateClientServiceInput,
	CreateClientServiceKeyInput,
	CreateClientServiceKeyResult,
	CreateClientServicePolicyInput,
	JsonObject,
	UpdateClientServiceImageResizePolicyInput,
	UpdateClientServiceImageResizeVariantInput,
	UpdateClientServiceLifecycleSubscriptionInput,
	UpdateClientServiceInput,
	UpdateClientServicePolicyInput,
} from './client-services.types';
import {
	ClientServiceImageResizeVariantNotFoundError,
	ClientServiceKeyNotFoundError,
	ClientServiceLifecycleSubscriptionNotFoundError,
	ClientServiceNotFoundError,
	ClientServicePolicyNotFoundError,
	ClientServicesRepository,
	DuplicateClientServiceImageResizeVariantError,
	DuplicateClientServiceLifecycleSubscriptionError,
	DuplicateClientServiceSlugError,
} from './client-services.repository';
import { CLIENT_SERVICES_REPOSITORY } from './client-services-repository.provider';
import { KafkaLifecycleProvisionerService } from './kafka-lifecycle-provisioner.service';

const SERVICE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CONSUMER_GROUP_PATTERN = /^[A-Za-z0-9._-]{2,128}$/;
const MAX_RESIZE_DIMENSION = 10_000;

@Injectable()
export class ClientServicesService {
	constructor(
		@Inject(CLIENT_SERVICES_REPOSITORY)
		private readonly repository: ClientServicesRepository,
		@Optional()
		private readonly lifecycleProvisioner?: KafkaLifecycleProvisionerService,
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
		auditContext?: AdminActionContext,
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
			await this.recordAudit({
				context: auditContext,
				clientServiceId,
				action: 'client-service.key.created',
				targetType: 'client-service-key',
				targetId: key.id,
				metadata: {
					keyPrefix: key.keyPrefix,
					...(key.name ? { name: key.name } : {}),
					...(key.scopes ? { scopes: key.scopes } : {}),
					...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
				},
			});
			return { apiKey: generated.apiKey, key };
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async revokeKey(
		clientServiceId: string,
		keyId: string,
		auditContext?: AdminActionContext,
	) {
		try {
			const key = await this.repository.revokeKey({
				clientServiceId,
				keyId,
				revokedAt: new Date().toISOString(),
			});
			await this.recordAudit({
				context: auditContext,
				clientServiceId,
				action: 'client-service.key.revoked',
				targetType: 'client-service-key',
				targetId: key.id,
				metadata: { keyPrefix: key.keyPrefix },
			});
			return key;
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async createLifecycleSubscription(
		clientServiceId: string,
		payload: unknown,
		auditContext?: AdminActionContext,
	) {
		const input = parseCreateLifecycleSubscriptionInput(payload);
		try {
			const requestedEnabled = input.isEnabled ?? true;
			const provisioning = await this.provisionLifecycleSubscription({
				clientServiceId,
				consumerGroup: input.consumerGroup,
				subscriptionEnabled: requestedEnabled,
			});
			const subscription = await this.repository.createLifecycleSubscription({
				clientServiceId,
				...input,
				isEnabled:
					requestedEnabled &&
					provisioning.provisioningStatus !==
						ClientServiceLifecycleProvisioningStatus.Failed,
				...provisioning,
			});
			await this.recordAudit({
				context: auditContext,
				clientServiceId,
				action: 'client-service.subscription.created',
				targetType: 'lifecycle-subscription',
				targetId: subscription.id,
				metadata: {
					eventType: subscription.eventType,
					consumerGroup: subscription.consumerGroup,
					isEnabled: subscription.isEnabled,
					topic: subscription.topic,
					principal: subscription.principal,
					provisioningStatus: subscription.provisioningStatus,
				},
			});
			return subscription;
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async updateLifecycleSubscription(
		clientServiceId: string,
		subscriptionId: string,
		payload: unknown,
		auditContext?: AdminActionContext,
	) {
		const input = parseUpdateLifecycleSubscriptionInput(payload);
		try {
			let provisioning: ClientServiceLifecycleProvisioningRecord | undefined;
			if (input.isEnabled === true || input.consumerGroup !== undefined) {
				const clientService =
					await this.repository.findServiceById(clientServiceId);
				const currentSubscription = clientService?.lifecycleSubscriptions?.find(
					(subscription) => subscription.id === subscriptionId,
				);
				if (!currentSubscription) {
					throw new ClientServiceLifecycleSubscriptionNotFoundError(
						subscriptionId,
					);
				}
				const requestedEnabled =
					input.isEnabled ?? currentSubscription.isEnabled;
				if (requestedEnabled) {
					provisioning = await this.provisionLifecycleSubscription({
						clientServiceId,
						consumerGroup:
							input.consumerGroup ?? currentSubscription.consumerGroup,
						previousConsumerGroup: currentSubscription.consumerGroup,
						subscriptionEnabled: true,
					});
				}
			}
			const subscription = await this.repository.updateLifecycleSubscription({
				clientServiceId,
				subscriptionId,
				...input,
				...(provisioning ?? {}),
				...(provisioning?.provisioningStatus ===
				ClientServiceLifecycleProvisioningStatus.Failed
					? { isEnabled: false }
					: {}),
			});
			await this.recordAudit({
				context: auditContext,
				clientServiceId,
				action: 'client-service.subscription.updated',
				targetType: 'lifecycle-subscription',
				targetId: subscription.id,
				metadata: {
					eventType: subscription.eventType,
					consumerGroup: subscription.consumerGroup,
					isEnabled: subscription.isEnabled,
					topic: subscription.topic,
					principal: subscription.principal,
					provisioningStatus: subscription.provisioningStatus,
				},
			});
			return subscription;
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	private provisionLifecycleSubscription(input: {
		clientServiceId: string;
		consumerGroup: string;
		previousConsumerGroup?: string;
		subscriptionEnabled: boolean;
	}): Promise<ClientServiceLifecycleProvisioningRecord> {
		if (this.lifecycleProvisioner) {
			return this.lifecycleProvisioner.provision(input);
		}
		return Promise.resolve({
			topic: createClientLifecycleTopic(input.clientServiceId),
			principal: createClientLifecyclePrincipal(input.clientServiceId),
			provisioningStatus: ClientServiceLifecycleProvisioningStatus.Pending,
			provisioningError: null,
			provisionedAt: null,
		});
	}

	async createPolicy(
		clientServiceId: string,
		payload: unknown,
		auditContext?: AdminActionContext,
	) {
		const input = parseCreatePolicyInput(payload);
		try {
			const policy = await this.repository.createPolicy({
				clientServiceId,
				...input,
			});
			await this.recordPolicyAudit('created', policy, auditContext);
			return policy;
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async updatePolicy(
		clientServiceId: string,
		policyId: string,
		payload: unknown,
		auditContext?: AdminActionContext,
	) {
		const input = parseUpdatePolicyInput(payload);
		try {
			const policy = await this.repository.updatePolicy({
				clientServiceId,
				policyId,
				...input,
			});
			await this.recordPolicyAudit('updated', policy, auditContext);
			return policy;
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async deletePolicy(
		clientServiceId: string,
		policyId: string,
		auditContext?: AdminActionContext,
	) {
		try {
			const policy = await this.repository.deletePolicy({
				clientServiceId,
				policyId,
			});
			await this.recordPolicyAudit('deleted', policy, auditContext);
			return policy;
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	listAuditLogs(clientServiceId: string) {
		return this.repository.listAuditLogs(clientServiceId);
	}

	async getImageResizePolicy(clientServiceId: string) {
		try {
			return await this.repository.getOrCreateImageResizePolicy(
				clientServiceId,
			);
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async updateImageResizePolicy(
		clientServiceId: string,
		payload: unknown,
		auditContext?: AdminActionContext,
	) {
		const input = parseUpdateImageResizePolicyInput(payload);
		try {
			const policy = await this.repository.updateImageResizePolicy(
				clientServiceId,
				input,
			);
			await this.recordAudit({
				context: auditContext,
				clientServiceId,
				action: 'client-service.resize-policy.updated',
				targetType: 'image-resize-policy',
				targetId: policy.id,
				metadata: { mode: policy.mode },
			});
			return policy;
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async createImageResizeVariant(
		clientServiceId: string,
		payload: unknown,
		auditContext?: AdminActionContext,
	) {
		const input = parseCreateImageResizeVariantInput(payload);
		try {
			const variant = await this.repository.createImageResizeVariant({
				clientServiceId,
				...input,
				isEnabled: input.isEnabled ?? true,
			});
			await this.recordResizeVariantAudit(
				'created',
				clientServiceId,
				variant,
				auditContext,
			);
			return variant;
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async updateImageResizeVariant(
		clientServiceId: string,
		variantId: string,
		payload: unknown,
		auditContext?: AdminActionContext,
	) {
		const input = parseUpdateImageResizeVariantInput(payload);
		try {
			const variant = await this.repository.updateImageResizeVariant({
				clientServiceId,
				variantId,
				...input,
			});
			await this.recordResizeVariantAudit(
				'updated',
				clientServiceId,
				variant,
				auditContext,
			);
			return variant;
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	async deleteImageResizeVariant(
		clientServiceId: string,
		variantId: string,
		auditContext?: AdminActionContext,
	) {
		try {
			const variant = await this.repository.deleteImageResizeVariant({
				clientServiceId,
				variantId,
			});
			await this.recordResizeVariantAudit(
				'deleted',
				clientServiceId,
				variant,
				auditContext,
			);
			return variant;
		} catch (error) {
			throw mapRepositoryError(error);
		}
	}

	private recordResizeVariantAudit(
		operation: 'created' | 'updated' | 'deleted',
		clientServiceId: string,
		variant: Awaited<
			ReturnType<ClientServicesRepository['createImageResizeVariant']>
		>,
		context?: AdminActionContext,
	) {
		return this.recordAudit({
			context,
			clientServiceId,
			action: `client-service.resize-variant.${operation}`,
			targetType: 'image-resize-variant',
			targetId: variant.id,
			metadata: {
				...(variant.width !== undefined ? { width: variant.width } : {}),
				...(variant.height !== undefined ? { height: variant.height } : {}),
				format: variant.format,
				isEnabled: variant.isEnabled,
			},
		});
	}

	private recordPolicyAudit(
		operation: 'created' | 'updated' | 'deleted',
		policy: Awaited<ReturnType<ClientServicesRepository['createPolicy']>>,
		context?: AdminActionContext,
	) {
		return this.recordAudit({
			context,
			clientServiceId: policy.clientServiceId,
			action: `client-service.access-policy.${operation}`,
			targetType: 'client-service-policy',
			targetId: policy.id,
			metadata: {
				pathPattern: policy.pathPattern,
				canRead: policy.canRead,
				canUpload: policy.canUpload,
				canDelete: policy.canDelete,
				...(policy.maxUploadBytes !== undefined
					? { maxUploadBytes: policy.maxUploadBytes }
					: {}),
				...(policy.rateLimitPerMin !== undefined
					? { rateLimitPerMin: policy.rateLimitPerMin }
					: {}),
			},
		});
	}

	private recordAudit(input: {
		context?: AdminActionContext;
		clientServiceId: string;
		action: string;
		targetType: string;
		targetId: string;
		metadata?: JsonObject;
	}) {
		return this.repository.createAuditLog({
			clientServiceId: input.clientServiceId,
			actor: input.context?.actor ?? 'system',
			requestId: input.context?.requestId ?? 'system',
			action: input.action,
			targetType: input.targetType,
			targetId: input.targetId,
			metadata: input.metadata,
		});
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
	const scopes = readOptionalJsonObject(record, 'scopes');
	validateClientServiceKeyScopes(scopes);
	return {
		name: readOptionalString(record, 'name'),
		scopes,
		expiresAt,
	};
}

function validateClientServiceKeyScopes(scopes: JsonObject | undefined) {
	if (!scopes) return;
	for (const action of ['read', 'upload', 'delete'] as const) {
		if (scopes[action] !== undefined && typeof scopes[action] !== 'boolean') {
			throw new BadRequestException(`scopes.${action} must be a boolean`);
		}
	}
	if (scopes.actions !== undefined) {
		if (
			!Array.isArray(scopes.actions) ||
			scopes.actions.length === 0 ||
			scopes.actions.some(
				(action) =>
					action !== 'read' && action !== 'upload' && action !== 'delete',
			)
		) {
			throw new BadRequestException(
				'scopes.actions must contain read, upload or delete',
			);
		}
	}
	if (scopes.pathPatterns !== undefined) {
		if (
			!Array.isArray(scopes.pathPatterns) ||
			scopes.pathPatterns.length === 0 ||
			scopes.pathPatterns.some((pattern) => typeof pattern !== 'string')
		) {
			throw new BadRequestException(
				'scopes.pathPatterns must be a non-empty string array',
			);
		}
		for (const pattern of scopes.pathPatterns as string[]) {
			normalizeClientServicePathPattern(pattern);
		}
	}
}

function parseCreatePolicyInput(
	payload: unknown,
): CreateClientServicePolicyInput {
	const record = requireRecord(payload);
	return {
		pathPattern: normalizeClientServicePathPattern(
			readRequiredString(record, 'pathPattern'),
		),
		canRead: readOptionalBoolean(record, 'canRead'),
		canUpload: readOptionalBoolean(record, 'canUpload'),
		canDelete: readOptionalBoolean(record, 'canDelete'),
		maxUploadBytes: readOptionalPositiveInteger(record, 'maxUploadBytes'),
		rateLimitPerMin: readOptionalPositiveInteger(record, 'rateLimitPerMin'),
		metadata: readOptionalJsonObject(record, 'metadata'),
	};
}

function parseUpdatePolicyInput(
	payload: unknown,
): UpdateClientServicePolicyInput {
	const record = requireRecord(payload);
	const rawPathPattern = readOptionalString(record, 'pathPattern');
	const input: UpdateClientServicePolicyInput = {
		pathPattern:
			rawPathPattern === undefined
				? undefined
				: normalizeClientServicePathPattern(rawPathPattern),
		canRead: readOptionalBoolean(record, 'canRead'),
		canUpload: readOptionalBoolean(record, 'canUpload'),
		canDelete: readOptionalBoolean(record, 'canDelete'),
		maxUploadBytes: readNullablePositiveInteger(record, 'maxUploadBytes'),
		rateLimitPerMin: readNullablePositiveInteger(record, 'rateLimitPerMin'),
		metadata:
			record.metadata === null
				? null
				: readOptionalJsonObject(record, 'metadata'),
	};
	if (Object.values(input).every((value) => value === undefined)) {
		throw new BadRequestException('수정할 정책 필드가 필요합니다');
	}
	return input;
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

function parseUpdateImageResizePolicyInput(
	payload: unknown,
): UpdateClientServiceImageResizePolicyInput {
	const record = requireRecord(payload);
	return { mode: readRequiredImageResizeMode(record, 'mode') };
}

function parseCreateImageResizeVariantInput(
	payload: unknown,
): CreateClientServiceImageResizeVariantInput {
	const record = requireRecord(payload);
	const input: CreateClientServiceImageResizeVariantInput = {
		width: readOptionalResizeDimension(record, 'width'),
		height: readOptionalResizeDimension(record, 'height'),
		format: readRequiredImageResizeFormat(record, 'format'),
		isEnabled: readOptionalBoolean(record, 'isEnabled'),
		description: readOptionalString(record, 'description'),
	};
	assertHasResizeDimension(input);
	return input;
}

function parseUpdateImageResizeVariantInput(
	payload: unknown,
): UpdateClientServiceImageResizeVariantInput {
	const record = requireRecord(payload);
	const input: UpdateClientServiceImageResizeVariantInput = {
		width: readOptionalResizeDimension(record, 'width'),
		height: readOptionalResizeDimension(record, 'height'),
		format: readOptionalImageResizeFormat(record, 'format'),
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
			`${key} must be image.upload.completed, image.upload.failed, image.delete.completed, or image.delete.failed`,
		);
	}
	return value as ClientServiceLifecycleEventType;
}

function readRequiredImageResizeMode(
	record: Record<string, unknown>,
	key: string,
): ClientServiceImageResizeMode {
	const value = record[key];
	if (
		!Object.values(ClientServiceImageResizeMode).includes(
			value as ClientServiceImageResizeMode,
		)
	) {
		throw new BadRequestException(`${key} must be ON_DEMAND or PRE_GENERATE`);
	}
	return value as ClientServiceImageResizeMode;
}

function readRequiredImageResizeFormat(
	record: Record<string, unknown>,
	key: string,
): ClientServiceImageResizeFormat {
	const value = readOptionalImageResizeFormat(record, key);
	if (!value) {
		throw new BadRequestException(`${key} is required`);
	}
	return value;
}

function readOptionalImageResizeFormat(
	record: Record<string, unknown>,
	key: string,
): ClientServiceImageResizeFormat | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (
		!Object.values(ClientServiceImageResizeFormat).includes(
			value as ClientServiceImageResizeFormat,
		)
	) {
		throw new BadRequestException(`${key} must be png, jpeg or webp`);
	}
	return value as ClientServiceImageResizeFormat;
}

function readOptionalResizeDimension(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value <= 0 ||
		value > MAX_RESIZE_DIMENSION
	) {
		throw new BadRequestException(
			`${key} must be an integer between 1 and ${MAX_RESIZE_DIMENSION}`,
		);
	}
	return value;
}

function assertHasResizeDimension(input: {
	width?: number;
	height?: number;
}): void {
	if (input.width === undefined && input.height === undefined) {
		throw new BadRequestException('width 또는 height 중 하나는 필요합니다');
	}
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

function readOptionalPositiveInteger(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value <= 0 ||
		value > 2_147_483_647
	) {
		throw new BadRequestException(`${key} must be a positive integer`);
	}
	return value;
}

function readNullablePositiveInteger(
	record: Record<string, unknown>,
	key: string,
): number | null | undefined {
	return record[key] === null ? null : readOptionalPositiveInteger(record, key);
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
	if (error instanceof DuplicateClientServiceImageResizeVariantError) {
		return new ConflictException(
			'client service image resize variant already exists',
		);
	}
	if (error instanceof ClientServiceNotFoundError) {
		return new NotFoundException('client service not found');
	}
	if (error instanceof ClientServiceKeyNotFoundError) {
		return new NotFoundException('client service key not found');
	}
	if (error instanceof ClientServicePolicyNotFoundError) {
		return new NotFoundException('client service policy not found');
	}
	if (error instanceof ClientServiceLifecycleSubscriptionNotFoundError) {
		return new NotFoundException(
			'client service lifecycle subscription not found',
		);
	}
	if (error instanceof ClientServiceImageResizeVariantNotFoundError) {
		return new NotFoundException(
			'client service image resize variant not found',
		);
	}
	return error instanceof Error ? error : new Error('unknown repository error');
}
