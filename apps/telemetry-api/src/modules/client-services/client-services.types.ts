export const ClientServiceStatus = {
	Active: 'ACTIVE',
	Disabled: 'DISABLED',
} as const;
export type ClientServiceStatus =
	(typeof ClientServiceStatus)[keyof typeof ClientServiceStatus];

export type JsonObject = Record<string, unknown>;

export interface ClientServiceRecord {
	id: string;
	slug: string;
	name: string;
	description?: string;
	owner?: string;
	status: ClientServiceStatus;
	createdAt: string;
	updatedAt: string;
	keyCount: number;
	activeKeyCount: number;
	keys?: ClientServiceKeyRecord[];
}

export interface ClientServiceKeyRecord {
	id: string;
	clientServiceId: string;
	name?: string;
	keyPrefix: string;
	scopes?: JsonObject;
	expiresAt?: string;
	revokedAt?: string;
	lastUsedAt?: string;
	createdAt: string;
}

export interface CreateClientServiceInput {
	slug: string;
	name: string;
	description?: string;
	owner?: string;
	status?: ClientServiceStatus;
}

export interface UpdateClientServiceInput {
	slug?: string;
	name?: string;
	description?: string | null;
	owner?: string | null;
	status?: ClientServiceStatus;
}

export interface CreateClientServiceKeyInput {
	name?: string;
	scopes?: JsonObject;
	expiresAt?: string;
}

export interface CreateClientServiceKeyResult {
	apiKey: string;
	key: ClientServiceKeyRecord;
}
