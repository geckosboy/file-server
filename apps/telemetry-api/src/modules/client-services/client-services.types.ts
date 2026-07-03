export const ClientServiceStatus = {
	Active: 'ACTIVE',
	Disabled: 'DISABLED',
} as const;
export type ClientServiceStatus =
	(typeof ClientServiceStatus)[keyof typeof ClientServiceStatus];

export type JsonObject = Record<string, unknown>;

export const ClientServiceLifecycleEventType = {
	UploadCompleted: 'image.upload.completed',
	UploadFailed: 'image.upload.failed',
} as const;
export type ClientServiceLifecycleEventType =
	(typeof ClientServiceLifecycleEventType)[keyof typeof ClientServiceLifecycleEventType];

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
	subscriptionCount: number;
	activeSubscriptionCount: number;
	keys?: ClientServiceKeyRecord[];
	lifecycleSubscriptions?: ClientServiceLifecycleSubscriptionRecord[];
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

export interface ClientServiceLifecycleSubscriptionRecord {
	id: string;
	clientServiceId: string;
	eventType: ClientServiceLifecycleEventType;
	consumerGroup: string;
	isEnabled: boolean;
	description?: string;
	createdAt: string;
	updatedAt: string;
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

export interface CreateClientServiceLifecycleSubscriptionInput {
	eventType: ClientServiceLifecycleEventType;
	consumerGroup: string;
	isEnabled?: boolean;
	description?: string;
}

export interface UpdateClientServiceLifecycleSubscriptionInput {
	eventType?: ClientServiceLifecycleEventType;
	consumerGroup?: string;
	isEnabled?: boolean;
	description?: string | null;
}

export interface CreateClientServiceKeyResult {
	apiKey: string;
	key: ClientServiceKeyRecord;
}
