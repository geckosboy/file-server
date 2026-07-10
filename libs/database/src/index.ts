export { PrismaModule } from './prisma.module';
export { PrismaService } from './prisma.service';
export {
	ImageAssetMetadataRepository,
	createImageVariantSpecKey,
	type AssetTransactionWork,
	type ClaimVariantJobResult,
	type CompleteUploadInput,
	type CompleteVariantJobInput,
	type CreatePendingUploadInput,
	type ImageVariantJobEvent,
	type ImageVariantSpec,
	type ReadyImageAssetForVariants,
	type RepairReadyAssetInput,
} from './image-asset-metadata.repository';
export {
	extractClientApiKeyPrefix,
	generateClientApiKey,
	hashClientApiKey,
	isSameClientApiKeyHash,
	type GeneratedClientApiKey,
} from './client-api-key';

export {
	CLIENT_SERVICE_API_KEY_HEADER,
	CLIENT_SERVICE_REQUEST_ID_HEADER,
	CLIENT_SERVICE_TRACE_ID_HEADER,
	INTERNAL_API_KEY_HEADER,
	INTERNAL_CLIENT_CONTEXT_HEADER,
	INTERNAL_CLIENT_CONTEXT_SIGNATURE_HEADER,
	ClientServiceApiKeyGuard,
	ClientServiceAuthService,
	InternalServiceGuard,
	ClientServiceContext,
	InternalServiceAccess,
	createInternalServiceForwardHeaders,
	createClientServiceTelemetryFields,
	getClientServiceContext,
	getInternalServiceAccess,
	type AuthenticatedClientService,
	type ClientServiceAuthenticatedRequest,
	type ClientServiceAuthContext,
	type ClientServiceTelemetryFields,
	type CreateInternalServiceForwardHeadersOptions,
	type InternalServiceAccessContext,
	type InternalServiceAccessRequirement,
} from './client-service-auth';
export { ClientServiceAuthModule } from './client-service-auth.module';
export {
	getClientServiceAuthMetricsSnapshot,
	resetClientServiceAuthMetricsForTesting,
	type ClientServiceAuthMetricsSnapshot,
} from './client-service-auth.metrics';
export {
	ClientServiceAction,
	ClientServiceAuthorizationService,
	type ClientServiceAuthorizationDecision,
	type ClientServiceAuthorizationInput,
} from './client-service-authorization';
