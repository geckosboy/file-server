import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@file/database';
import {
	ClientServiceImageResizePolicyRecord,
	ClientServiceImageResizeVariantRecord,
	ClientServiceLifecycleSubscriptionRecord,
	ClientServiceKeyRecord,
	ClientServiceRecord,
	ClientServiceStatus,
	CreateClientServiceImageResizeVariantInput,
	CreateClientServiceLifecycleSubscriptionInput,
	CreateClientServiceInput,
	JsonObject,
	UpdateClientServiceImageResizePolicyInput,
	UpdateClientServiceImageResizeVariantInput,
	UpdateClientServiceLifecycleSubscriptionInput,
	UpdateClientServiceInput,
} from './client-services.types';
import {
	ClientServiceImageResizeVariantNotFoundError,
	ClientServiceKeyNotFoundError,
	ClientServiceLifecycleSubscriptionNotFoundError,
	ClientServiceNotFoundError,
	ClientServicesRepository,
	DuplicateClientServiceImageResizeVariantError,
	DuplicateClientServiceLifecycleSubscriptionError,
	DuplicateClientServiceSlugError,
} from './client-services.repository';

@Injectable()
export class PrismaClientServicesRepository implements ClientServicesRepository {
	constructor(private readonly prisma: PrismaService) {}

	async listServices(): Promise<ClientServiceRecord[]> {
		const services = await this.prisma.clientService.findMany({
			include: serviceInclude,
			orderBy: { slug: 'asc' },
		});
		return services.map((service) => toServiceRecord(service));
	}

	async findServiceById(id: string): Promise<ClientServiceRecord | null> {
		const service = await this.prisma.clientService.findUnique({
			where: { id },
			include: serviceInclude,
		});
		return service ? toServiceRecord(service, true) : null;
	}

	async findServiceBySlug(slug: string): Promise<ClientServiceRecord | null> {
		const service = await this.prisma.clientService.findUnique({
			where: { slug },
			include: serviceInclude,
		});
		return service ? toServiceRecord(service, true) : null;
	}

	async createService(
		input: CreateClientServiceInput & { status: ClientServiceStatus },
	): Promise<ClientServiceRecord> {
		try {
			const service = await this.prisma.clientService.create({
				data: input,
				include: serviceInclude,
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
				include: serviceInclude,
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

	async getOrCreateImageResizePolicy(
		clientServiceId: string,
	): Promise<ClientServiceImageResizePolicyRecord> {
		await this.assertClientServiceExists(clientServiceId);
		return toImageResizePolicyRecord(
			await this.prisma.clientServiceImageResizePolicy.upsert({
				where: { clientServiceId },
				create: { clientServiceId, mode: 'ON_DEMAND' },
				update: {},
				include: imageResizePolicyInclude,
			}),
		);
	}

	async updateImageResizePolicy(
		clientServiceId: string,
		input: UpdateClientServiceImageResizePolicyInput,
	): Promise<ClientServiceImageResizePolicyRecord> {
		await this.assertClientServiceExists(clientServiceId);
		return toImageResizePolicyRecord(
			await this.prisma.clientServiceImageResizePolicy.upsert({
				where: { clientServiceId },
				create: { clientServiceId, mode: input.mode },
				update: { mode: input.mode },
				include: imageResizePolicyInclude,
			}),
		);
	}

	async createImageResizeVariant(
		input: CreateClientServiceImageResizeVariantInput & {
			clientServiceId: string;
			isEnabled: boolean;
		},
	): Promise<ClientServiceImageResizeVariantRecord> {
		const policy = await this.getOrCreateImageResizePolicy(
			input.clientServiceId,
		);
		try {
			return toImageResizeVariantRecord(
				await this.prisma.clientServiceImageResizeVariant.create({
					data: {
						policyId: policy.id,
						width: input.width,
						height: input.height,
						format: input.format,
						isEnabled: input.isEnabled,
						description: input.description,
					},
				}),
			);
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				throw new DuplicateClientServiceImageResizeVariantError(
					`${policy.id}:${input.width ?? 'auto'}:${input.height ?? 'auto'}:${input.format}`,
				);
			}
			throw error;
		}
	}

	async updateImageResizeVariant(
		input: UpdateClientServiceImageResizeVariantInput & {
			clientServiceId: string;
			variantId: string;
		},
	): Promise<ClientServiceImageResizeVariantRecord> {
		const variant = await this.findImageResizeVariant(
			input.clientServiceId,
			input.variantId,
		);

		try {
			return toImageResizeVariantRecord(
				await this.prisma.clientServiceImageResizeVariant.update({
					where: { id: variant.id },
					data: {
						width: input.width,
						height: input.height,
						format: input.format,
						isEnabled: input.isEnabled,
						description: input.description === null ? null : input.description,
					},
				}),
			);
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				throw new DuplicateClientServiceImageResizeVariantError(
					`${variant.policyId}:${input.width ?? variant.width ?? 'auto'}:${input.height ?? variant.height ?? 'auto'}:${input.format ?? variant.format}`,
				);
			}
			throw error;
		}
	}

	async deleteImageResizeVariant(input: {
		clientServiceId: string;
		variantId: string;
	}): Promise<ClientServiceImageResizeVariantRecord> {
		const variant = await this.findImageResizeVariant(
			input.clientServiceId,
			input.variantId,
		);
		return toImageResizeVariantRecord(
			await this.prisma.clientServiceImageResizeVariant.delete({
				where: { id: variant.id },
			}),
		);
	}

	private async assertClientServiceExists(
		clientServiceId: string,
	): Promise<void> {
		const service = await this.prisma.clientService.findUnique({
			where: { id: clientServiceId },
			select: { id: true },
		});
		if (!service) {
			throw new ClientServiceNotFoundError(clientServiceId);
		}
	}

	private async findImageResizeVariant(
		clientServiceId: string,
		variantId: string,
	): Promise<ImageResizeVariantRow> {
		const variant = await this.prisma.clientServiceImageResizeVariant.findFirst(
			{
				where: {
					id: variantId,
					policy: { clientServiceId },
				},
			},
		);
		if (!variant) {
			throw new ClientServiceImageResizeVariantNotFoundError(variantId);
		}
		return variant;
	}

	async clear(): Promise<void> {
		await this.prisma.$transaction([
			this.prisma.clientServiceKey.deleteMany(),
			this.prisma.clientServiceLifecycleSubscription.deleteMany(),
			this.prisma.clientServiceImageResizeVariant.deleteMany(),
			this.prisma.clientServiceImageResizePolicy.deleteMany(),
			this.prisma.clientServicePolicy.deleteMany(),
			this.prisma.clientService.deleteMany(),
		]);
	}

	getStorageKind(): 'postgresql' {
		return 'postgresql';
	}
}

const imageResizePolicyInclude = {
	variants: true,
} satisfies Prisma.ClientServiceImageResizePolicyInclude;

const serviceInclude = {
	keys: true,
	lifecycleSubscriptions: true,
	imageResizePolicy: { include: imageResizePolicyInclude },
} satisfies Prisma.ClientServiceInclude;

type ServiceWithKeys = Prisma.ClientServiceGetPayload<{
	include: typeof serviceInclude;
}>;
type KeyRow = Prisma.ClientServiceKeyGetPayload<Record<string, never>>;
type LifecycleSubscriptionRow =
	Prisma.ClientServiceLifecycleSubscriptionGetPayload<Record<string, never>>;
type ImageResizePolicyRow = Prisma.ClientServiceImageResizePolicyGetPayload<{
	include: typeof imageResizePolicyInclude;
}>;
type ImageResizeVariantRow = Prisma.ClientServiceImageResizeVariantGetPayload<
	Record<string, never>
>;

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
		...(includeKeys && service.imageResizePolicy
			? {
					imageResizePolicy: toImageResizePolicyRecord(
						service.imageResizePolicy,
					),
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

function toImageResizePolicyRecord(
	policy: ImageResizePolicyRow,
): ClientServiceImageResizePolicyRecord {
	return {
		id: policy.id,
		clientServiceId: policy.clientServiceId,
		mode: policy.mode as ClientServiceImageResizePolicyRecord['mode'],
		variants: [...policy.variants]
			.sort(compareResizeVariants)
			.map(toImageResizeVariantRecord),
		createdAt: policy.createdAt.toISOString(),
		updatedAt: policy.updatedAt.toISOString(),
	};
}

function toImageResizeVariantRecord(
	variant: ImageResizeVariantRow,
): ClientServiceImageResizeVariantRecord {
	return {
		id: variant.id,
		policyId: variant.policyId,
		width: variant.width ?? undefined,
		height: variant.height ?? undefined,
		format: variant.format as ClientServiceImageResizeVariantRecord['format'],
		isEnabled: variant.isEnabled,
		description: variant.description ?? undefined,
		createdAt: variant.createdAt.toISOString(),
		updatedAt: variant.updatedAt.toISOString(),
	};
}

function compareResizeVariants(
	left: ImageResizeVariantRow,
	right: ImageResizeVariantRow,
): number {
	return (
		(left.width ?? 0) - (right.width ?? 0) ||
		(left.height ?? 0) - (right.height ?? 0) ||
		left.format.localeCompare(right.format)
	);
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
