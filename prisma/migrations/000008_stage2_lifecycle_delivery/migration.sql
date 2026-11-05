-- Preserve dual-publish progress per destination instead of collapsing an
-- event to one row. Existing canonical rows keep their event id unchanged.
DROP INDEX "image_lifecycle_outbox_event_id_key";

ALTER TABLE "image_lifecycle_outbox"
  ADD COLUMN "lease_owner" TEXT,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "dead_lettered_at" TIMESTAMP(3);

DROP INDEX "image_lifecycle_outbox_status_next_attempt_at_idx";

CREATE UNIQUE INDEX "image_lifecycle_outbox_event_id_topic_key"
  ON "image_lifecycle_outbox"("event_id", "topic");
CREATE INDEX "image_lifecycle_outbox_claim_idx"
  ON "image_lifecycle_outbox"("status", "next_attempt_at", "lease_expires_at");
CREATE INDEX "image_lifecycle_outbox_published_retention_idx"
  ON "image_lifecycle_outbox"("status", "published_at");
CREATE INDEX "image_lifecycle_outbox_dead_letter_retention_idx"
  ON "image_lifecycle_outbox"("status", "dead_lettered_at");

-- Subscription metadata records the server-computed destination and the
-- least-privilege Kafka principal that owns its consume ACL.
ALTER TABLE "client_service_lifecycle_subscriptions"
  ADD COLUMN "topic" TEXT,
  ADD COLUMN "principal" TEXT,
  ADD COLUMN "provisioning_status" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "provisioning_error" TEXT,
  ADD COLUMN "provisioned_at" TIMESTAMP(3);

UPDATE "client_service_lifecycle_subscriptions"
SET
  "topic" = 'file.image.lifecycle.client.' || lower("client_service_id") || '.v1',
  "principal" = 'User:file-lifecycle-' || lower("client_service_id")
WHERE "topic" IS NULL OR "principal" IS NULL;

ALTER TABLE "client_service_lifecycle_subscriptions"
  ALTER COLUMN "topic" SET NOT NULL,
  ALTER COLUMN "principal" SET NOT NULL;

CREATE INDEX "client_service_lifecycle_subscriptions_topic_idx"
  ON "client_service_lifecycle_subscriptions"("topic");
CREATE INDEX "client_service_lifecycle_subscriptions_provisioning_status_idx"
  ON "client_service_lifecycle_subscriptions"("provisioning_status");
