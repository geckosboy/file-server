import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@file/database';
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
import {
	ClientServiceKeyNotFoundError,
	ClientServiceLifecycleSubscriptionNotFoundError,
	ClientServiceNotFoundError,
	ClientServicesRepository,
	DuplicateClientServiceLifecycleSubscriptionError,
	DuplicateClientServiceSlugError,
} from './client-services.repository';

@Injectable()
export class PrismaClientServicesRepository implements ClientServicesRepository {
	constructor(private readonly prisma: PrismaService) {}

	async listServices(): Promise<ClientServiceRecord[]> {
		const services = await this.prisma.clientService.findMany({
			include: { keys: true, lifecycleSubscriptions: true },
			orderBy: { slug: 'asc' },
		});
		return services.map((service) => toServiceRecord(service));
	}

	async findServiceById(id: string): Promise<ClientServiceRecord | null> {
		const service = await this.prisma.clientService.findUnique({
			where: { id },
			include: { keys: true, lifecycleSubscriptions: true },
		});
		return service ? toServiceRecord(service, true) : null;
	}

	async findServiceBySlug(slug: string): Promise<ClientServiceRecord | null> {
		const service = await this.prisma.clientService.findUnique({
			where: { slug },
			include: { keys: true, lifecycleSubscriptions: true },
		});
		return service ? toServiceRecord(service, true) : null;
	}

	async createService(
		input: CreateClientServiceInput & { status: ClientServiceStatus },
	): Promise<ClientServiceRecord> {
		try {
			const service = await this.prisma.clientService.create({
				data: input,
				include: { keys: true, lifecycleSubscriptions: true },
			});
			return toServiceRecord(service, true);
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				throw new DuplicateClientServiceSlugError(input.slug);
			}
			throw error;
		}
	}

	async updateService(
		id: string,
		input: UpdateClientServiceInput,
	): Promise<ClientServiceRecord> {
		try {
			const service = await this.prisma.clientService.update({
				where: { id },
				data: input,
				include: { keys: true, lifecycleSubscriptions: true },
			});
			return toServiceRecord(service, true);
		} catch (error) {
			if (isNotFoundError(error)) {
				throw new ClientServiceNotFoundError(id);
			}
			if (isUniqueConstraintError(error)) {
				throw new DuplicateClientServiceSlugError(input.slug ?? '');
			}
			throw error;
		}
	}

	async createKey(input: {
		clientServiceId: string;
		name?: string;
		keyPrefix: string;
		keyHash: string;
		scopes?: JsonObject;
		expiresAt?: string;
	}): Promise<ClientServiceKeyRecord> {
		try {
			const key = await this.prisma.clientServiceKey.create({
				data: {
					clientService: { connect: { id: input.clientServiceId } },
					name: input.name,
					keyPrefix: input.keyPrefix,
					keyHash: input.keyHash,
					scopes: input.scopes as Prisma.InputJsonValue | undefined,
					expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
				},
			});
			return toKeyRecord(key);
		} catch (error) {
			if (isNotFoundError(error)) {
				throw new ClientServiceNotFoundError(input.clientServiceId);
			}
			throw error;
		}
	}

	async revokeKey(input: {
		clientServiceId: string;
		keyId: string;
		revokedAt: string;
	}): Promise<ClientServiceKeyRecord> {
		const key = await this.prisma.clientServiceKey.findFirst({
			where: {
				id: input.keyId,
				clientServiceId: input.clientServiceId,
			},
		});
		if (!key) {
			throw new ClientServiceKeyNotFoundError(input.keyId);
		}

		return toKeyRecord(
			await this.prisma.clientServiceKey.update({
				where: { id: key.id },
				data: { revokedAt: new Date(input.revokedAt) },
			}),
		);
	}

	async createLifecycleSubscription(
		input: CreateClientServiceLifecycleSubscriptionInput & {
			clientServiceId: string;
			isEnabled: boolean;
		},
	): Promise<ClientServiceLifecycleSubscriptionRecord> {
		try {
			const subscription =
				await this.prisma.clientServiceLifecycleSubscription.create({
					data: {
						clientService: { connect: { id: input.clientServiceId } },
						eventType: input.eventType,
						consumerGroup: input.consumerGroup,
						isEnabled: input.isEnabled,
						description: input.description,
					},
				});
			return toLifecycleSubscriptionRecord(subscription);
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				throw new DuplicateClientServiceLifecycleSubscriptionError(
					`${input.clientServiceId}:${input.eventType}:${input.consumerGroup}`,
				);
			}
			if (isNotFoundError(error)) {
				throw new ClientServiceNotFoundError(input.clientServiceId);
			}
			throw error;
		}
	}

	async updateLifecycleSubscription(
		input: UpdateClientServiceLifecycleSubscriptionInput & {
			clientServiceId: string;
			subscriptionId: string;
		},
	): Promise<ClientServiceLifecycleSubscriptionRecord> {
		const subscription =
			await this.prisma.clientServiceLifecycleSubscription.findFirst({
				where: {
					id: input.subscriptionId,
					clientServiceId: input.clientServiceId,
				},
			});
		if (!subscription) {
			throw new ClientServiceLifecycleSubscriptionNotFoundError(
				input.subscriptionId,
			);
		}

		try {
			return toLifecycleSubscriptionRecord(
				await this.prisma.clientServiceLifecycleSubscription.update({
					where: { id: subscription.id },
					data: {
						eventType: input.eventType,
						consumerGroup: input.consumerGroup,
						isEnabled: input.isEnabled,
						description: input.description === null ? null : input.description,
					},
				}),
			);
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				throw new DuplicateClientServiceLifecycleSubscriptionError(
					`${input.clientServiceId}:${input.eventType ?? subscription.eventType}:${input.consumerGroup ?? subscription.consumerGroup}`,
				);
			}
			throw error;
		}
	}

	async clear(): Promise<void> {
		await this.prisma.$transaction([
			this.prisma.clientServiceKey.deleteMany(),
			this.prisma.clientServiceLifecycleSubscription.deleteMany(),
			this.prisma.clientServicePolicy.deleteMany(),
			this.prisma.clientService.deleteMany(),
		]);
	}

	getStorageKind(): 'postgresql' {
		return 'postgresql';
	}
}

type ServiceWithKeys = Prisma.ClientServiceGetPayload<{
	include: { keys: true; lifecycleSubscriptions: true };
}>;
type KeyRow = Prisma.ClientServiceKeyGetPayload<Record<string, never>>;
type LifecycleSubscriptionRow =
	Prisma.ClientServiceLifecycleSubscriptionGetPayload<Record<string, never>>;

function toServiceRecord(
	service: ServiceWithKeys,
	includeKeys = false,
): ClientServiceRecord {
	return {
		id: service.id,
		slug: service.slug,
		name: service.name,
		description: service.description ?? undefined,
		owner: service.owner ?? undefined,
		status: service.status as ClientServiceStatus,
		createdAt: service.createdAt.toISOString(),
		updatedAt: service.updatedAt.toISOString(),
		keyCount: service.keys.length,
		activeKeyCount: service.keys.filter((key) => !key.revokedAt).length,
		subscriptionCount: service.lifecycleSubscriptions.length,
		activeSubscriptionCount: service.lifecycleSubscriptions.filter(
			(subscription) => subscription.isEnabled,
		).length,
		...(includeKeys ? { keys: service.keys.map(toKeyRecord) } : {}),
		...(includeKeys
			? {
					lifecycleSubscriptions: [...service.lifecycleSubscriptions]
						.sort((left, right) =>
							left.eventType === right.eventType
								? left.consumerGroup.localeCompare(right.consumerGroup)
								: left.eventType.localeCompare(right.eventType),
						)
						.map(toLifecycleSubscriptionRecord),
				}
			: {}),
	};
}

function toKeyRecord(key: KeyRow): ClientServiceKeyRecord {
	return {
		id: key.id,
		clientServiceId: key.clientServiceId,
		name: key.name ?? undefined,
		keyPrefix: key.keyPrefix,
		scopes: toJsonObject(key.scopes),
		expiresAt: key.expiresAt?.toISOString(),
		revokedAt: key.revokedAt?.toISOString(),
		lastUsedAt: key.lastUsedAt?.toISOString(),
		createdAt: key.createdAt.toISOString(),
	};
}

function toLifecycleSubscriptionRecord(
	subscription: LifecycleSubscriptionRow,
): ClientServiceLifecycleSubscriptionRecord {
	return {
		id: subscription.id,
		clientServiceId: subscription.clientServiceId,
		eventType:
			subscription.eventType as ClientServiceLifecycleSubscriptionRecord['eventType'],
		consumerGroup: subscription.consumerGroup,
		isEnabled: subscription.isEnabled,
		description: subscription.description ?? undefined,
		createdAt: subscription.createdAt.toISOString(),
		updatedAt: subscription.updatedAt.toISOString(),
	};
}

function toJsonObject(value: Prisma.JsonValue | null): JsonObject | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === 'P2002'
	);
}

function isNotFoundError(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === 'P2025'
	);
}
