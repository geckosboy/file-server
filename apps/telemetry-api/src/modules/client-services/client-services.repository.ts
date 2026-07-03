import { Injectable } from '@nestjs/common';
import {
	ClientServiceKeyRecord,
	ClientServiceRecord,
	ClientServiceStatus,
	CreateClientServiceInput,
	JsonObject,
	UpdateClientServiceInput,
} from './client-services.types';

export class ClientServiceNotFoundError extends Error {}
export class ClientServiceKeyNotFoundError extends Error {}
export class DuplicateClientServiceSlugError extends Error {}

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

@Injectable()
export class InMemoryClientServicesRepository implements ClientServicesRepository {
	private readonly services = new Map<string, MutableClientService>();
	private readonly keys = new Map<string, MutableClientServiceKey>();
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

	async clear(): Promise<void> {
		this.services.clear();
		this.keys.clear();
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
			...(includeKeys ? { keys: keys.map(toKeyRecord) } : {}),
		};
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

function stripUndefined<T extends Record<string, unknown>>(
	input: T,
): Partial<T> {
	return Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}
