import { Injectable } from '@nestjs/common';
import {
	AdminAuditLogRecord,
	ClientServiceImageResizePolicyRecord,
	ClientServiceImageResizeVariantRecord,
	ClientServiceLifecycleSubscriptionRecord,
	ClientServiceKeyRecord,
	ClientServiceRecord,
	ClientServicePolicyRecord,
	ClientServiceStatus,
	CreateClientServiceImageResizeVariantInput,
	CreateClientServiceLifecycleSubscriptionInput,
	CreateClientServiceInput,
	CreateClientServicePolicyInput,
	JsonObject,
	UpdateClientServiceImageResizePolicyInput,
	UpdateClientServiceImageResizeVariantInput,
	UpdateClientServiceLifecycleSubscriptionInput,
	UpdateClientServiceInput,
	UpdateClientServicePolicyInput,
} from './client-services.types';

export class ClientServiceNotFoundError extends Error {}
export class ClientServiceKeyNotFoundError extends Error {}
export class ClientServicePolicyNotFoundError extends Error {}
export class ClientServiceLifecycleSubscriptionNotFoundError extends Error {}
export class ClientServiceImageResizePolicyNotFoundError extends Error {}
export class ClientServiceImageResizeVariantNotFoundError extends Error {}
export class DuplicateClientServiceSlugError extends Error {}
export class DuplicateClientServiceLifecycleSubscriptionError extends Error {}
export class DuplicateClientServiceImageResizeVariantError extends Error {}

export interface ClientServicesRepository {
	listServices(): Promise<ClientServiceRecord[]>;
	findServiceById(id: string): Promise<ClientServiceRecord | null>;
	findServiceBySlug(slug: string): Promise<ClientServiceRecord | null>;
	createService(
		input: CreateClientServiceInput & { status: ClientServiceStatus },
	): Promise<ClientServiceRecord>;
	updateService(
		id: string,
		input: UpdateClientServiceInput,
	): Promise<ClientServiceRecord>;
	createKey(input: {
		clientServiceId: string;
		name?: string;
		keyPrefix: string;
		keyHash: string;
		scopes?: JsonObject;
		expiresAt?: string;
	}): Promise<ClientServiceKeyRecord>;
	revokeKey(input: {
		clientServiceId: string;
		keyId: string;
		revokedAt: string;
	}): Promise<ClientServiceKeyRecord>;
	createPolicy(
		input: CreateClientServicePolicyInput & { clientServiceId: string },
	): Promise<ClientServicePolicyRecord>;
	updatePolicy(
		input: UpdateClientServicePolicyInput & {
			clientServiceId: string;
			policyId: string;
		},
	): Promise<ClientServicePolicyRecord>;
	deletePolicy(input: {
		clientServiceId: string;
		policyId: string;
	}): Promise<ClientServicePolicyRecord>;
	createAuditLog(input: {
		clientServiceId?: string;
		actor: string;
		requestId: string;
		action: string;
		targetType: string;
		targetId: string;
		metadata?: JsonObject;
	}): Promise<AdminAuditLogRecord>;
	listAuditLogs(clientServiceId: string): Promise<AdminAuditLogRecord[]>;
	createLifecycleSubscription(
		input: CreateClientServiceLifecycleSubscriptionInput & {
			clientServiceId: string;
			isEnabled: boolean;
		},
	): Promise<ClientServiceLifecycleSubscriptionRecord>;
	updateLifecycleSubscription(
		input: UpdateClientServiceLifecycleSubscriptionInput & {
			clientServiceId: string;
			subscriptionId: string;
		},
	): Promise<ClientServiceLifecycleSubscriptionRecord>;
	getOrCreateImageResizePolicy(
		clientServiceId: string,
	): Promise<ClientServiceImageResizePolicyRecord>;
	updateImageResizePolicy(
		clientServiceId: string,
		input: UpdateClientServiceImageResizePolicyInput,
	): Promise<ClientServiceImageResizePolicyRecord>;
	createImageResizeVariant(
		input: CreateClientServiceImageResizeVariantInput & {
			clientServiceId: string;
			isEnabled: boolean;
		},
	): Promise<ClientServiceImageResizeVariantRecord>;
	updateImageResizeVariant(
		input: UpdateClientServiceImageResizeVariantInput & {
			clientServiceId: string;
			variantId: string;
		},
	): Promise<ClientServiceImageResizeVariantRecord>;
	deleteImageResizeVariant(input: {
		clientServiceId: string;
		variantId: string;
	}): Promise<ClientServiceImageResizeVariantRecord>;
	clear(): Promise<void>;
	getStorageKind(): 'memory' | 'postgresql';
}

interface MutableClientService {
	id: string;
	slug: string;
	name: string;
	description?: string;
	owner?: string;
	status: ClientServiceStatus;
	createdAt: string;
	updatedAt: string;
}

interface MutableClientServiceKey {
	id: string;
	clientServiceId: string;
	name?: string;
	keyPrefix: string;
	keyHash: string;
	scopes?: JsonObject;
	expiresAt?: string;
	revokedAt?: string;
	lastUsedAt?: string;
	createdAt: string;
}

interface MutableClientServicePolicy {
	id: string;
	clientServiceId: string;
	pathPattern: string;
	canRead: boolean;
	canUpload: boolean;
	canDelete: boolean;
	maxUploadBytes?: number;
	rateLimitPerMin?: number;
	metadata?: JsonObject;
	createdAt: string;
	updatedAt: string;
}

interface MutableAdminAuditLog extends Omit<
	AdminAuditLogRecord,
	'id' | 'createdAt'
> {
	id: string;
	createdAt: string;
}

interface MutableClientServiceLifecycleSubscription {
	id: string;
	clientServiceId: string;
	eventType: ClientServiceLifecycleSubscriptionRecord['eventType'];
	consumerGroup: string;
	isEnabled: boolean;
	description?: string;
	createdAt: string;
	updatedAt: string;
}

interface MutableClientServiceImageResizePolicy {
	id: string;
	clientServiceId: string;
	mode: ClientServiceImageResizePolicyRecord['mode'];
	createdAt: string;
	updatedAt: string;
}

interface MutableClientServiceImageResizeVariant {
	id: string;
	policyId: string;
	width?: number;
	height?: number;
	format: ClientServiceImageResizeVariantRecord['format'];
	isEnabled: boolean;
	description?: string;
	createdAt: string;
	updatedAt: string;
}

@Injectable()
export class InMemoryClientServicesRepository implements ClientServicesRepository {
	private readonly services = new Map<string, MutableClientService>();
	private readonly keys = new Map<string, MutableClientServiceKey>();
	private readonly policies = new Map<string, MutableClientServicePolicy>();
	private readonly auditLogs = new Map<string, MutableAdminAuditLog>();
	private readonly lifecycleSubscriptions = new Map<
		string,
		MutableClientServiceLifecycleSubscription
	>();
	private readonly imageResizePolicies = new Map<
		string,
		MutableClientServiceImageResizePolicy
	>();
	private readonly imageResizeVariants = new Map<
		string,
		MutableClientServiceImageResizeVariant
	>();
	private sequence = 0;

	async listServices(): Promise<ClientServiceRecord[]> {
		return [...this.services.values()]
			.sort((left, right) => left.slug.localeCompare(right.slug))
			.map((service) => this.toServiceRecord(service));
	}

	async findServiceById(id: string): Promise<ClientServiceRecord | null> {
		const service = this.services.get(id);
		return service ? this.toServiceRecord(service, true) : null;
	}

	async findServiceBySlug(slug: string): Promise<ClientServiceRecord | null> {
		const service = [...this.services.values()].find(
			(item) => item.slug === slug,
		);
		return service ? this.toServiceRecord(service, true) : null;
	}

	async createService(
		input: CreateClientServiceInput & { status: ClientServiceStatus },
	): Promise<ClientServiceRecord> {
		if (
			[...this.services.values()].some((service) => service.slug === input.slug)
		) {
			throw new DuplicateClientServiceSlugError(input.slug);
		}

		const now = new Date().toISOString();
		const service: MutableClientService = {
			id: `svc_${++this.sequence}`,
			slug: input.slug,
			name: input.name,
			description: input.description,
			owner: input.owner,
			status: input.status,
			createdAt: now,
			updatedAt: now,
		};
		this.services.set(service.id, service);
		return this.toServiceRecord(service, true);
	}

	async updateService(
		id: string,
		input: UpdateClientServiceInput,
	): Promise<ClientServiceRecord> {
		const service = this.services.get(id);
		if (!service) {
			throw new ClientServiceNotFoundError(id);
		}
		if (
			input.slug &&
			[...this.services.values()].some(
				(item) => item.id !== id && item.slug === input.slug,
			)
		) {
			throw new DuplicateClientServiceSlugError(input.slug);
		}

		const next: MutableClientService = {
			...service,
			...stripUndefined({
				slug: input.slug,
				name: input.name,
				status: input.status,
			}),
			description:
				input.description === null
					? undefined
					: (input.description ?? service.description),
			owner: input.owner === null ? undefined : (input.owner ?? service.owner),
			updatedAt: new Date().toISOString(),
		};
		this.services.set(id, next);
		return this.toServiceRecord(next, true);
	}

	async createKey(input: {
		clientServiceId: string;
		name?: string;
		keyPrefix: string;
		keyHash: string;
		scopes?: JsonObject;
		expiresAt?: string;
	}): Promise<ClientServiceKeyRecord> {
		if (!this.services.has(input.clientServiceId)) {
			throw new ClientServiceNotFoundError(input.clientServiceId);
		}

		const key: MutableClientServiceKey = {
			id: `key_${++this.sequence}`,
			clientServiceId: input.clientServiceId,
			name: input.name,
			keyPrefix: input.keyPrefix,
			keyHash: input.keyHash,
			scopes: input.scopes,
			expiresAt: input.expiresAt,
			createdAt: new Date().toISOString(),
		};
		this.keys.set(key.id, key);
		return toKeyRecord(key);
	}

	async revokeKey(input: {
		clientServiceId: string;
		keyId: string;
		revokedAt: string;
	}): Promise<ClientServiceKeyRecord> {
		const key = this.keys.get(input.keyId);
		if (!key || key.clientServiceId !== input.clientServiceId) {
			throw new ClientServiceKeyNotFoundError(input.keyId);
		}

		const next = { ...key, revokedAt: input.revokedAt };
		this.keys.set(key.id, next);
		return toKeyRecord(next);
	}

	async createPolicy(
		input: CreateClientServicePolicyInput & { clientServiceId: string },
	): Promise<ClientServicePolicyRecord> {
		if (!this.services.has(input.clientServiceId)) {
			throw new ClientServiceNotFoundError(input.clientServiceId);
		}
		const now = new Date().toISOString();
		const policy: MutableClientServicePolicy = {
			id: `access_policy_${++this.sequence}`,
			clientServiceId: input.clientServiceId,
			pathPattern: input.pathPattern,
			canRead: input.canRead ?? true,
			canUpload: input.canUpload ?? false,
			canDelete: input.canDelete ?? false,
			maxUploadBytes: input.maxUploadBytes,
			rateLimitPerMin: input.rateLimitPerMin,
			metadata: input.metadata,
			createdAt: now,
			updatedAt: now,
		};
		this.policies.set(policy.id, policy);
		return toPolicyRecord(policy);
	}

	async updatePolicy(
		input: UpdateClientServicePolicyInput & {
			clientServiceId: string;
			policyId: string;
		},
	): Promise<ClientServicePolicyRecord> {
		const policy = this.policies.get(input.policyId);
		if (!policy || policy.clientServiceId !== input.clientServiceId) {
			throw new ClientServicePolicyNotFoundError(input.policyId);
		}
		const next: MutableClientServicePolicy = {
			...policy,
			...stripUndefined({
				pathPattern: input.pathPattern,
				canRead: input.canRead,
				canUpload: input.canUpload,
				canDelete: input.canDelete,
			}),
			maxUploadBytes:
				input.maxUploadBytes === null
					? undefined
					: (input.maxUploadBytes ?? policy.maxUploadBytes),
			rateLimitPerMin:
				input.rateLimitPerMin === null
					? undefined
					: (input.rateLimitPerMin ?? policy.rateLimitPerMin),
			metadata:
				input.metadata === null
					? undefined
					: (input.metadata ?? policy.metadata),
			updatedAt: new Date().toISOString(),
		};
		this.policies.set(policy.id, next);
		return toPolicyRecord(next);
	}

	async deletePolicy(input: {
		clientServiceId: string;
		policyId: string;
	}): Promise<ClientServicePolicyRecord> {
		const policy = this.policies.get(input.policyId);
		if (!policy || policy.clientServiceId !== input.clientServiceId) {
			throw new ClientServicePolicyNotFoundError(input.policyId);
		}
		this.policies.delete(policy.id);
		return toPolicyRecord(policy);
	}

	async createAuditLog(input: {
		clientServiceId?: string;
		actor: string;
		requestId: string;
		action: string;
		targetType: string;
		targetId: string;
		metadata?: JsonObject;
	}): Promise<AdminAuditLogRecord> {
		const auditLog: MutableAdminAuditLog = {
			id: `audit_${++this.sequence}`,
			...input,
			createdAt: new Date().toISOString(),
		};
		this.auditLogs.set(auditLog.id, auditLog);
		return { ...auditLog };
	}

	async listAuditLogs(clientServiceId: string): Promise<AdminAuditLogRecord[]> {
		return [...this.auditLogs.values()]
			.filter((log) => log.clientServiceId === clientServiceId)
			.reverse()
			.map((log) => ({ ...log }));
	}

	async createLifecycleSubscription(
		input: CreateClientServiceLifecycleSubscriptionInput & {
			clientServiceId: string;
			isEnabled: boolean;
		},
	): Promise<ClientServiceLifecycleSubscriptionRecord> {
		if (!this.services.has(input.clientServiceId)) {
			throw new ClientServiceNotFoundError(input.clientServiceId);
		}
		this.assertUniqueLifecycleSubscription(input);

		const now = new Date().toISOString();
		const subscription: MutableClientServiceLifecycleSubscription = {
			id: `sub_${++this.sequence}`,
			clientServiceId: input.clientServiceId,
			eventType: input.eventType,
			consumerGroup: input.consumerGroup,
			isEnabled: input.isEnabled,
			description: input.description,
			createdAt: now,
			updatedAt: now,
		};
		this.lifecycleSubscriptions.set(subscription.id, subscription);
		return toLifecycleSubscriptionRecord(subscription);
	}

	async updateLifecycleSubscription(
		input: UpdateClientServiceLifecycleSubscriptionInput & {
			clientServiceId: string;
			subscriptionId: string;
		},
	): Promise<ClientServiceLifecycleSubscriptionRecord> {
		const subscription = this.lifecycleSubscriptions.get(input.subscriptionId);
		if (
			!subscription ||
			subscription.clientServiceId !== input.clientServiceId
		) {
			throw new ClientServiceLifecycleSubscriptionNotFoundError(
				input.subscriptionId,
			);
		}

		const next: MutableClientServiceLifecycleSubscription = {
			...subscription,
			...stripUndefined({
				eventType: input.eventType,
				consumerGroup: input.consumerGroup,
				isEnabled: input.isEnabled,
			}),
			description:
				input.description === null
					? undefined
					: (input.description ?? subscription.description),
			updatedAt: new Date().toISOString(),
		};
		this.assertUniqueLifecycleSubscription(next, subscription.id);
		this.lifecycleSubscriptions.set(subscription.id, next);
		return toLifecycleSubscriptionRecord(next);
	}

	async getOrCreateImageResizePolicy(
		clientServiceId: string,
	): Promise<ClientServiceImageResizePolicyRecord> {
		if (!this.services.has(clientServiceId)) {
			throw new ClientServiceNotFoundError(clientServiceId);
		}
		return this.toImageResizePolicyRecord(
			this.getOrCreateMutableImageResizePolicy(clientServiceId),
		);
	}

	async updateImageResizePolicy(
		clientServiceId: string,
		input: UpdateClientServiceImageResizePolicyInput,
	): Promise<ClientServiceImageResizePolicyRecord> {
		const policy = this.getOrCreateMutableImageResizePolicy(clientServiceId);
		const next: MutableClientServiceImageResizePolicy = {
			...policy,
			mode: input.mode,
			updatedAt: new Date().toISOString(),
		};
		this.imageResizePolicies.set(next.id, next);
		return this.toImageResizePolicyRecord(next);
	}

	async createImageResizeVariant(
		input: CreateClientServiceImageResizeVariantInput & {
			clientServiceId: string;
			isEnabled: boolean;
		},
	): Promise<ClientServiceImageResizeVariantRecord> {
		const policy = this.getOrCreateMutableImageResizePolicy(
			input.clientServiceId,
		);
		this.assertUniqueImageResizeVariant(policy.id, input);

		const now = new Date().toISOString();
		const variant: MutableClientServiceImageResizeVariant = {
			id: `variant_${++this.sequence}`,
			policyId: policy.id,
			width: input.width,
			height: input.height,
			format: input.format,
			isEnabled: input.isEnabled,
			description: input.description,
			createdAt: now,
			updatedAt: now,
		};
		this.imageResizeVariants.set(variant.id, variant);
		return toImageResizeVariantRecord(variant);
	}

	async updateImageResizeVariant(
		input: UpdateClientServiceImageResizeVariantInput & {
			clientServiceId: string;
			variantId: string;
		},
	): Promise<ClientServiceImageResizeVariantRecord> {
		const { policy, variant } = this.findMutableImageResizeVariant(input);
		const next: MutableClientServiceImageResizeVariant = {
			...variant,
			...stripUndefined({
				width: input.width,
				height: input.height,
				format: input.format,
				isEnabled: input.isEnabled,
			}),
			description:
				input.description === null
					? undefined
					: (input.description ?? variant.description),
			updatedAt: new Date().toISOString(),
		};
		this.assertUniqueImageResizeVariant(policy.id, next, variant.id);
		this.imageResizeVariants.set(variant.id, next);
		return toImageResizeVariantRecord(next);
	}

	async deleteImageResizeVariant(input: {
		clientServiceId: string;
		variantId: string;
	}): Promise<ClientServiceImageResizeVariantRecord> {
		const { variant } = this.findMutableImageResizeVariant(input);
		this.imageResizeVariants.delete(variant.id);
		return toImageResizeVariantRecord(variant);
	}

	async clear(): Promise<void> {
		this.services.clear();
		this.keys.clear();
		this.policies.clear();
		this.auditLogs.clear();
		this.lifecycleSubscriptions.clear();
		this.imageResizePolicies.clear();
		this.imageResizeVariants.clear();
	}

	getStorageKind(): 'memory' {
		return 'memory';
	}

	private toServiceRecord(
		service: MutableClientService,
		includeKeys = false,
	): ClientServiceRecord {
		const keys = [...this.keys.values()].filter(
			(key) => key.clientServiceId === service.id,
		);
		const lifecycleSubscriptions = [...this.lifecycleSubscriptions.values()]
			.filter((subscription) => subscription.clientServiceId === service.id)
			.sort((left, right) =>
				left.eventType === right.eventType
					? left.consumerGroup.localeCompare(right.consumerGroup)
					: left.eventType.localeCompare(right.eventType),
			);
		const imageResizePolicy = [...this.imageResizePolicies.values()].find(
			(policy) => policy.clientServiceId === service.id,
		);
		const policies = [...this.policies.values()]
			.filter((policy) => policy.clientServiceId === service.id)
			.sort((left, right) => left.pathPattern.localeCompare(right.pathPattern));
		return {
			id: service.id,
			slug: service.slug,
			name: service.name,
			description: service.description,
			owner: service.owner,
			status: service.status,
			createdAt: service.createdAt,
			updatedAt: service.updatedAt,
			keyCount: keys.length,
			activeKeyCount: keys.filter((key) => !key.revokedAt).length,
			subscriptionCount: lifecycleSubscriptions.length,
			activeSubscriptionCount: lifecycleSubscriptions.filter(
				(subscription) => subscription.isEnabled,
			).length,
			policyCount: policies.length,
			...(includeKeys ? { keys: keys.map(toKeyRecord) } : {}),
			...(includeKeys ? { policies: policies.map(toPolicyRecord) } : {}),
			...(includeKeys
				? {
						lifecycleSubscriptions: lifecycleSubscriptions.map(
							toLifecycleSubscriptionRecord,
						),
					}
				: {}),
			...(includeKeys && imageResizePolicy
				? {
						imageResizePolicy:
							this.toImageResizePolicyRecord(imageResizePolicy),
					}
				: {}),
		};
	}

	private getOrCreateMutableImageResizePolicy(
		clientServiceId: string,
	): MutableClientServiceImageResizePolicy {
		if (!this.services.has(clientServiceId)) {
			throw new ClientServiceNotFoundError(clientServiceId);
		}

		const existing = [...this.imageResizePolicies.values()].find(
			(policy) => policy.clientServiceId === clientServiceId,
		);
		if (existing) {
			return existing;
		}

		const now = new Date().toISOString();
		const policy: MutableClientServiceImageResizePolicy = {
			id: `policy_${++this.sequence}`,
			clientServiceId,
			mode: 'ON_DEMAND',
			createdAt: now,
			updatedAt: now,
		};
		this.imageResizePolicies.set(policy.id, policy);
		return policy;
	}

	private toImageResizePolicyRecord(
		policy: MutableClientServiceImageResizePolicy,
	): ClientServiceImageResizePolicyRecord {
		return {
			id: policy.id,
			clientServiceId: policy.clientServiceId,
			mode: policy.mode,
			variants: [...this.imageResizeVariants.values()]
				.filter((variant) => variant.policyId === policy.id)
				.sort(compareResizeVariants)
				.map(toImageResizeVariantRecord),
			createdAt: policy.createdAt,
			updatedAt: policy.updatedAt,
		};
	}

	private findMutableImageResizeVariant(input: {
		clientServiceId: string;
		variantId: string;
	}): {
		policy: MutableClientServiceImageResizePolicy;
		variant: MutableClientServiceImageResizeVariant;
	} {
		const policy = [...this.imageResizePolicies.values()].find(
			(item) => item.clientServiceId === input.clientServiceId,
		);
		const variant = this.imageResizeVariants.get(input.variantId);
		if (!policy || !variant || variant.policyId !== policy.id) {
			throw new ClientServiceImageResizeVariantNotFoundError(input.variantId);
		}
		return { policy, variant };
	}

	private assertUniqueImageResizeVariant(
		policyId: string,
		input: {
			width?: number;
			height?: number;
			format?: string;
		},
		ignoreId?: string,
	): void {
		const duplicated = [...this.imageResizeVariants.values()].some(
			(variant) =>
				variant.id !== ignoreId &&
				variant.policyId === policyId &&
				variant.width === input.width &&
				variant.height === input.height &&
				variant.format === input.format,
		);
		if (duplicated) {
			throw new DuplicateClientServiceImageResizeVariantError(
				`${policyId}:${input.width ?? 'auto'}:${input.height ?? 'auto'}:${input.format}`,
			);
		}
	}

	private assertUniqueLifecycleSubscription(
		input: {
			clientServiceId: string;
			eventType: string;
			consumerGroup: string;
		},
		ignoreId?: string,
	): void {
		const duplicated = [...this.lifecycleSubscriptions.values()].some(
			(subscription) =>
				subscription.id !== ignoreId &&
				subscription.clientServiceId === input.clientServiceId &&
				subscription.eventType === input.eventType &&
				subscription.consumerGroup === input.consumerGroup,
		);
		if (duplicated) {
			throw new DuplicateClientServiceLifecycleSubscriptionError(
				`${input.clientServiceId}:${input.eventType}:${input.consumerGroup}`,
			);
		}
	}
}

function toKeyRecord(key: MutableClientServiceKey): ClientServiceKeyRecord {
	return {
		id: key.id,
		clientServiceId: key.clientServiceId,
		name: key.name,
		keyPrefix: key.keyPrefix,
		scopes: key.scopes,
		expiresAt: key.expiresAt,
		revokedAt: key.revokedAt,
		lastUsedAt: key.lastUsedAt,
		createdAt: key.createdAt,
	};
}

function toPolicyRecord(
	policy: MutableClientServicePolicy,
): ClientServicePolicyRecord {
	return { ...policy };
}

function toLifecycleSubscriptionRecord(
	subscription: MutableClientServiceLifecycleSubscription,
): ClientServiceLifecycleSubscriptionRecord {
	return {
		id: subscription.id,
		clientServiceId: subscription.clientServiceId,
		eventType: subscription.eventType,
		consumerGroup: subscription.consumerGroup,
		isEnabled: subscription.isEnabled,
		description: subscription.description,
		createdAt: subscription.createdAt,
		updatedAt: subscription.updatedAt,
	};
}

function toImageResizeVariantRecord(
	variant: MutableClientServiceImageResizeVariant,
): ClientServiceImageResizeVariantRecord {
	return {
		id: variant.id,
		policyId: variant.policyId,
		width: variant.width,
		height: variant.height,
		format: variant.format,
		isEnabled: variant.isEnabled,
		description: variant.description,
		createdAt: variant.createdAt,
		updatedAt: variant.updatedAt,
	};
}

function compareResizeVariants(
	left: MutableClientServiceImageResizeVariant,
	right: MutableClientServiceImageResizeVariant,
): number {
	return (
		(left.width ?? 0) - (right.width ?? 0) ||
		(left.height ?? 0) - (right.height ?? 0) ||
		left.format.localeCompare(right.format)
	);
}

function stripUndefined<T extends Record<string, unknown>>(
	input: T,
): Partial<T> {
	return Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}
