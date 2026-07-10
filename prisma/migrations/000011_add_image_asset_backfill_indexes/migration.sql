-- These source tables may already contain millions of events. Keep online index
-- creation in its own non-transactional migration so expand does not block
-- telemetry/lifecycle ingestion while the image asset backfill is prepared.
--
-- If a concurrent build is interrupted, follow the image asset lifecycle runbook: verify the
-- invalid catalog entry, drop it concurrently outside Prisma's migration
-- transaction, resolve this migration as rolled back, and retry deploy.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "telemetry_events_image_asset_backfill_idx"
  ON "telemetry_events"(
    "event_type",
    "status",
    "client_service_id",
    "image_key",
    "occurred_at" DESC,
    "event_id" DESC
  );

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "image_lifecycle_events_image_asset_backfill_idx"
  ON "image_lifecycle_events"(
    "event_type",
    "status",
    "client_service_id",
    "image_key",
    "occurred_at" DESC,
    "event_id" DESC
  );
