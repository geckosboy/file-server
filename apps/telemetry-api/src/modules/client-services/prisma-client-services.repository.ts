import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@file/database';
import {
	ClientServiceKeyRecord,
	ClientServiceRecord,
	ClientServiceStatus,
	CreateClientServiceInput,
	JsonObject,
	UpdateClientServiceInput,
} from './client-services.types';
import {
	ClientServiceKeyNotFoundError,
	ClientServiceNotFoundError,
	ClientServicesRepository,
	DuplicateClientServiceSlugError,
} from './client-services.repository';

@Injectable()
export class PrismaClientServicesRepository implements ClientServicesRepository {
	constructor(private readonly prisma: PrismaService) {}

	async listServices(): Promise<ClientServiceRecord[]> {
		const services = await this.prisma.clientService.findMany({
			include: { keys: true },
			orderBy: { slug: 'asc' },
		});
		return services.map((service) => toServiceRecord(service));
	}

	async findServiceById(id: string): Promise<ClientServiceRecord | null> {
		const service = await this.prisma.clientService.findUnique({
			where: { id },
			include: { keys: true },
		});
		return service ? toServiceRecord(service, true) : null;
	}

	async findServiceBySlug(slug: string): Promise<ClientServiceRecord | null> {
		const service = await this.prisma.clientService.findUnique({
			where: { slug },
			include: { keys: true },
		});
		return service ? toServiceRecord(service, true) : null;
	}

	async createService(
		input: CreateClientServiceInput & { status: ClientServiceStatus },
	): Promise<ClientServiceRecord> {
		try {
			const service = await this.prisma.clientService.create({
				data: input,
				include: { keys: true },
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
				include: { keys: true },
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

	async clear(): Promise<void> {
		await this.prisma.$transaction([
			this.prisma.clientServiceKey.deleteMany(),
			this.prisma.clientServicePolicy.deleteMany(),
			this.prisma.clientService.deleteMany(),
		]);
	}

	getStorageKind(): 'postgresql' {
		return 'postgresql';
	}
}

type ServiceWithKeys = Prisma.ClientServiceGetPayload<{
	include: { keys: true };
}>;
type KeyRow = Prisma.ClientServiceKeyGetPayload<Record<string, never>>;

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
		...(includeKeys ? { keys: service.keys.map(toKeyRecord) } : {}),
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
