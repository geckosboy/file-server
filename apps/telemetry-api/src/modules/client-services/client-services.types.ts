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

export const ClientServiceImageResizeMode = {
	OnDemand: 'ON_DEMAND',
	PreGenerate: 'PRE_GENERATE',
} as const;
export type ClientServiceImageResizeMode =
	(typeof ClientServiceImageResizeMode)[keyof typeof ClientServiceImageResizeMode];

export const ClientServiceImageResizeFormat = {
	Png: 'png',
	Jpeg: 'jpeg',
	Webp: 'webp',
} as const;
export type ClientServiceImageResizeFormat =
	(typeof ClientServiceImageResizeFormat)[keyof typeof ClientServiceImageResizeFormat];

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
	policyCount: number;
	keys?: ClientServiceKeyRecord[];
	policies?: ClientServicePolicyRecord[];
	lifecycleSubscriptions?: ClientServiceLifecycleSubscriptionRecord[];
	imageResizePolicy?: ClientServiceImageResizePolicyRecord;
}

export interface ClientServicePolicyRecord {
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

export interface AdminAuditLogRecord {
	id: string;
	clientServiceId?: string;
	actor: string;
	requestId: string;
	action: string;
	targetType: string;
	targetId: string;
	metadata?: JsonObject;
	createdAt: string;
}

export interface AdminActionContext {
	actor: string;
	requestId: string;
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

export interface ClientServiceImageResizePolicyRecord {
	id: string;
	clientServiceId: string;
	mode: ClientServiceImageResizeMode;
	variants: ClientServiceImageResizeVariantRecord[];
	createdAt: string;
	updatedAt: string;
}

export interface ClientServiceImageResizeVariantRecord {
	id: string;
	policyId: string;
	width?: number;
	height?: number;
	format: ClientServiceImageResizeFormat;
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

export interface CreateClientServicePolicyInput {
	pathPattern: string;
	canRead?: boolean;
	canUpload?: boolean;
	canDelete?: boolean;
	maxUploadBytes?: number;
	rateLimitPerMin?: number;
	metadata?: JsonObject;
}

export interface UpdateClientServicePolicyInput {
	pathPattern?: string;
	canRead?: boolean;
	canUpload?: boolean;
	canDelete?: boolean;
	maxUploadBytes?: number | null;
	rateLimitPerMin?: number | null;
	metadata?: JsonObject | null;
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

export interface UpdateClientServiceImageResizePolicyInput {
	mode: ClientServiceImageResizeMode;
}

export interface CreateClientServiceImageResizeVariantInput {
	width?: number;
	height?: number;
	format: ClientServiceImageResizeFormat;
	isEnabled?: boolean;
	description?: string;
}

export interface UpdateClientServiceImageResizeVariantInput {
	width?: number;
	height?: number;
	format?: ClientServiceImageResizeFormat;
	isEnabled?: boolean;
	description?: string | null;
}

export interface CreateClientServiceKeyResult {
	apiKey: string;
	key: ClientServiceKeyRecord;
}
