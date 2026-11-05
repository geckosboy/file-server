-- Stage 3: expand-only indexes for stable keyset scans and bounded analytics.
--
-- CREATE INDEX CONCURRENTLY is intentionally kept in its own idempotent
-- migration. Do not wrap this migration in BEGIN/COMMIT. Prisma Migrate runs
-- PostgreSQL migrations without an implicit transaction, so production writes
-- remain available while these indexes are built.

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "telemetry_events_occurred_at_event_id_idx"
  ON "telemetry_events"("occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "telemetry_events_client_service_occurred_event_idx"
  ON "telemetry_events"("client_service_id", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "telemetry_events_client_slug_occurred_event_idx"
  ON "telemetry_events"("client_service_slug", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "telemetry_events_event_type_occurred_event_idx"
  ON "telemetry_events"("event_type", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "telemetry_events_source_app_occurred_event_idx"
  ON "telemetry_events"("source_app", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "telemetry_events_status_occurred_event_idx"
  ON "telemetry_events"("status", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "telemetry_events_image_key_occurred_event_idx"
  ON "telemetry_events"("image_key", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "telemetry_events_retention_occurred_at_id_idx"
  ON "telemetry_events"("occurred_at", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "image_lifecycle_events_occurred_at_event_id_idx"
  ON "image_lifecycle_events"("occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "image_lifecycle_events_client_service_occurred_event_idx"
  ON "image_lifecycle_events"("client_service_id", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "image_lifecycle_events_client_slug_occurred_event_idx"
  ON "image_lifecycle_events"("client_service_slug", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "image_lifecycle_events_event_type_occurred_event_idx"
  ON "image_lifecycle_events"("event_type", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "image_lifecycle_events_source_app_occurred_event_idx"
  ON "image_lifecycle_events"("source_app", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "image_lifecycle_events_status_occurred_event_idx"
  ON "image_lifecycle_events"("status", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "image_lifecycle_events_image_key_occurred_event_idx"
  ON "image_lifecycle_events"("image_key", "occurred_at" DESC, "event_id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "image_lifecycle_events_retention_occurred_at_id_idx"
  ON "image_lifecycle_events"("occurred_at", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "admin_audit_logs_created_at_id_idx"
  ON "admin_audit_logs"("created_at" DESC, "id" DESC);
