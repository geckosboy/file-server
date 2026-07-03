CREATE TABLE "image_lifecycle_outbox" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "kafka_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "image_lifecycle_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "image_lifecycle_outbox_event_id_key" ON "image_lifecycle_outbox"("event_id");
CREATE INDEX "image_lifecycle_outbox_status_next_attempt_at_idx" ON "image_lifecycle_outbox"("status", "next_attempt_at");
CREATE INDEX "image_lifecycle_outbox_created_at_idx" ON "image_lifecycle_outbox"("created_at");
