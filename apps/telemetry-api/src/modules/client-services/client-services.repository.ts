import { Injectable } from '@nestjs/common';
import {
	ClientServiceLifecycleSubscriptionRecord,
	ClientServiceKeyRecord,
	ClientServiceRecord,
	ClientServiceStatus,
	CreateClientServiceLifecycleSubscriptionInput,
	CreateClientServiceInput,
	JsonObject,
	UpdateClientServiceLifecycleSubscriptionInput,
	UpdateClientServiceInput,
} from './client-services.types';

export class ClientServiceNotFoundError extends Error {}
export class ClientServiceKeyNotFoundError extends Error {}
export class ClientServiceLifecycleSubscriptionNotFoundError extends Error {}
export class DuplicateClientServiceSlugError extends Error {}
export class DuplicateClientServiceLifecycleSubscriptionError extends Error {}

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

@Injectable()
export class InMemoryClientServicesRepository implements ClientServicesRepository {
	private readonly services = new Map<string, MutableClientService>();
	private readonly keys = new Map<string, MutableClientServiceKey>();
	private readonly lifecycleSubscriptions = new Map<
		string,
		MutableClientServiceLifecycleSubscription
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

	async clear(): Promise<void> {
		this.services.clear();
		this.keys.clear();
		this.lifecycleSubscriptions.clear();
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
			...(includeKeys ? { keys: keys.map(toKeyRecord) } : {}),
			...(includeKeys
				? {
						lifecycleSubscriptions: lifecycleSubscriptions.map(
							toLifecycleSubscriptionRecord,
						),
					}
				: {}),
		};
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

function stripUndefined<T extends Record<string, unknown>>(
	input: T,
): Partial<T> {
	return Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}
