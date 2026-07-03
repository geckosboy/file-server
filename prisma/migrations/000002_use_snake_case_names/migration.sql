-- Rename Prisma-created PascalCase tables/columns to conventional PostgreSQL snake_case.
-- These are metadata-only renames and preserve existing local data.

-- Rename tables first so foreign key definitions continue to follow the same objects.
ALTER TABLE "ClientService" RENAME TO client_services;
ALTER TABLE "ClientServiceKey" RENAME TO client_service_keys;
ALTER TABLE "ClientServicePolicy" RENAME TO client_service_policies;
ALTER TABLE "TelemetryEvent" RENAME TO telemetry_events;
ALTER TABLE "TelemetryIngestionMetric" RENAME TO telemetry_ingestion_metrics;

-- client_services
ALTER TABLE client_services RENAME COLUMN "createdAt" TO created_at;
ALTER TABLE client_services RENAME COLUMN "updatedAt" TO updated_at;
ALTER TABLE client_services RENAME CONSTRAINT "ClientService_pkey" TO client_services_pkey;
ALTER INDEX "ClientService_slug_key" RENAME TO client_services_slug_key;
ALTER INDEX "ClientService_status_idx" RENAME TO client_services_status_idx;

-- client_service_keys
ALTER TABLE client_service_keys RENAME COLUMN "clientServiceId" TO client_service_id;
ALTER TABLE client_service_keys RENAME COLUMN "keyPrefix" TO key_prefix;
ALTER TABLE client_service_keys RENAME COLUMN "keyHash" TO key_hash;
ALTER TABLE client_service_keys RENAME COLUMN "expiresAt" TO expires_at;
ALTER TABLE client_service_keys RENAME COLUMN "revokedAt" TO revoked_at;
ALTER TABLE client_service_keys RENAME COLUMN "lastUsedAt" TO last_used_at;
ALTER TABLE client_service_keys RENAME COLUMN "createdAt" TO created_at;
ALTER TABLE client_service_keys RENAME CONSTRAINT "ClientServiceKey_pkey" TO client_service_keys_pkey;
ALTER TABLE client_service_keys RENAME CONSTRAINT "ClientServiceKey_clientServiceId_fkey" TO client_service_keys_client_service_id_fkey;
ALTER INDEX "ClientServiceKey_keyPrefix_key" RENAME TO client_service_keys_key_prefix_key;
ALTER INDEX "ClientServiceKey_keyHash_key" RENAME TO client_service_keys_key_hash_key;
ALTER INDEX "ClientServiceKey_clientServiceId_idx" RENAME TO client_service_keys_client_service_id_idx;
ALTER INDEX "ClientServiceKey_revokedAt_idx" RENAME TO client_service_keys_revoked_at_idx;
ALTER INDEX "ClientServiceKey_expiresAt_idx" RENAME TO client_service_keys_expires_at_idx;

-- client_service_policies
ALTER TABLE client_service_policies RENAME COLUMN "clientServiceId" TO client_service_id;
ALTER TABLE client_service_policies RENAME COLUMN "pathPattern" TO path_pattern;
ALTER TABLE client_service_policies RENAME COLUMN "canRead" TO can_read;
ALTER TABLE client_service_policies RENAME COLUMN "canUpload" TO can_upload;
ALTER TABLE client_service_policies RENAME COLUMN "canDelete" TO can_delete;
ALTER TABLE client_service_policies RENAME COLUMN "maxUploadBytes" TO max_upload_bytes;
ALTER TABLE client_service_policies RENAME COLUMN "rateLimitPerMin" TO rate_limit_per_min;
ALTER TABLE client_service_policies RENAME COLUMN "createdAt" TO created_at;
ALTER TABLE client_service_policies RENAME COLUMN "updatedAt" TO updated_at;
ALTER TABLE client_service_policies RENAME CONSTRAINT "ClientServicePolicy_pkey" TO client_service_policies_pkey;
ALTER TABLE client_service_policies RENAME CONSTRAINT "ClientServicePolicy_clientServiceId_fkey" TO client_service_policies_client_service_id_fkey;
ALTER INDEX "ClientServicePolicy_clientServiceId_idx" RENAME TO client_service_policies_client_service_id_idx;
ALTER INDEX "ClientServicePolicy_pathPattern_idx" RENAME TO client_service_policies_path_pattern_idx;

-- telemetry_events
ALTER TABLE telemetry_events RENAME COLUMN "eventId" TO event_id;
ALTER TABLE telemetry_events RENAME COLUMN "eventType" TO event_type;
ALTER TABLE telemetry_events RENAME COLUMN "sourceApp" TO source_app;
ALTER TABLE telemetry_events RENAME COLUMN "occurredAt" TO occurred_at;
ALTER TABLE telemetry_events RENAME COLUMN "receivedAt" TO received_at;
ALTER TABLE telemetry_events RENAME COLUMN "clientServiceId" TO client_service_id;
ALTER TABLE telemetry_events RENAME COLUMN "clientServiceSlug" TO client_service_slug;
ALTER TABLE telemetry_events RENAME COLUMN "requestId" TO request_id;
ALTER TABLE telemetry_events RENAME COLUMN "traceId" TO trace_id;
ALTER TABLE telemetry_events RENAME COLUMN "imageId" TO image_id;
ALTER TABLE telemetry_events RENAME COLUMN "imageKey" TO image_key;
ALTER TABLE telemetry_events RENAME COLUMN "cacheKey" TO cache_key;
ALTER TABLE telemetry_events RENAME COLUMN "inputBytes" TO input_bytes;
ALTER TABLE telemetry_events RENAME COLUMN "outputBytes" TO output_bytes;
ALTER TABLE telemetry_events RENAME COLUMN "durationMs" TO duration_ms;
ALTER TABLE telemetry_events RENAME COLUMN "errorCode" TO error_code;
ALTER TABLE telemetry_events RENAME COLUMN "errorMessage" TO error_message;
ALTER TABLE telemetry_events RENAME COLUMN "rawPayload" TO raw_payload;
ALTER TABLE telemetry_events RENAME CONSTRAINT "TelemetryEvent_pkey" TO telemetry_events_pkey;
ALTER TABLE telemetry_events RENAME CONSTRAINT "TelemetryEvent_clientServiceId_fkey" TO telemetry_events_client_service_id_fkey;
ALTER INDEX "TelemetryEvent_eventId_key" RENAME TO telemetry_events_event_id_key;
ALTER INDEX "TelemetryEvent_clientServiceId_occurredAt_idx" RENAME TO telemetry_events_client_service_id_occurred_at_idx;
ALTER INDEX "TelemetryEvent_clientServiceSlug_occurredAt_idx" RENAME TO telemetry_events_client_service_slug_occurred_at_idx;
ALTER INDEX "TelemetryEvent_eventType_occurredAt_idx" RENAME TO telemetry_events_event_type_occurred_at_idx;
ALTER INDEX "TelemetryEvent_sourceApp_occurredAt_idx" RENAME TO telemetry_events_source_app_occurred_at_idx;
ALTER INDEX "TelemetryEvent_status_occurredAt_idx" RENAME TO telemetry_events_status_occurred_at_idx;
ALTER INDEX "TelemetryEvent_imageKey_occurredAt_idx" RENAME TO telemetry_events_image_key_occurred_at_idx;
ALTER INDEX "TelemetryEvent_requestId_idx" RENAME TO telemetry_events_request_id_idx;
ALTER INDEX "TelemetryEvent_traceId_idx" RENAME TO telemetry_events_trace_id_idx;

-- telemetry_ingestion_metrics
ALTER TABLE telemetry_ingestion_metrics RENAME COLUMN "validationFailureCount" TO validation_failure_count;
ALTER TABLE telemetry_ingestion_metrics RENAME COLUMN "insertFailureCount" TO insert_failure_count;
ALTER TABLE telemetry_ingestion_metrics RENAME COLUMN "lastConsumedEventAt" TO last_consumed_event_at;
ALTER TABLE telemetry_ingestion_metrics RENAME COLUMN "updatedAt" TO updated_at;
ALTER TABLE telemetry_ingestion_metrics RENAME CONSTRAINT "TelemetryIngestionMetric_pkey" TO telemetry_ingestion_metrics_pkey;
