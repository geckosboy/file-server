-- Expand the telemetry-only projection into an authoritative asset ledger.
-- Data backfill is deliberately separated into the bounded, feature-gated
-- scripts/image-asset-backfill.mjs operation so expand deploys remain safe.
CREATE TYPE "ImageAssetState" AS ENUM ('Pending', 'Ready', 'Deleting', 'Deleted', 'Failed');
CREATE TYPE "ImageVariantState" AS ENUM ('Pending', 'Ready', 'Deleting', 'Deleted', 'Failed');
CREATE TYPE "ImageVariantJobState" AS ENUM ('Pending', 'Processing', 'Completed', 'Failed', 'Cancelled');

CREATE TABLE "image_assets" (
    "asset_id" TEXT NOT NULL,
    "client_service_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "source_event_id" TEXT,
    "delete_event_id" TEXT,
    "external_image_id" INTEGER,
    "logical_path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "input_bytes" INTEGER,
    "bytes" INTEGER,
    "checksum" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT,
    "status" "ImageAssetState" NOT NULL DEFAULT 'Pending',
    "failure_reason" TEXT,
    "cache_version" INTEGER NOT NULL DEFAULT 1,
    "ready_at" TIMESTAMP(3),
    "deleting_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "last_reconciled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "image_assets_pkey" PRIMARY KEY ("asset_id"),
    CONSTRAINT "image_assets_client_service_id_fkey" FOREIGN KEY ("client_service_id") REFERENCES "client_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "image_variants" (
    "variant_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "spec_key" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT NOT NULL,
    "source_checksum" TEXT NOT NULL,
    "bytes" INTEGER,
    "checksum" TEXT,
    "status" "ImageVariantState" NOT NULL DEFAULT 'Pending',
    "failure_reason" TEXT,
    "ready_at" TIMESTAMP(3),
    "deleting_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "image_variants_pkey" PRIMARY KEY ("variant_id"),
    CONSTRAINT "image_variants_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "image_assets"("asset_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "image_variant_jobs" (
    "job_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "job_key" TEXT NOT NULL,
    "status" "ImageVariantJobState" NOT NULL DEFAULT 'Pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "completed_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "publish_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_publish_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publish_last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "image_variant_jobs_pkey" PRIMARY KEY ("job_id"),
    CONSTRAINT "image_variant_jobs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "image_assets"("asset_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "image_variant_jobs_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "image_variants"("variant_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "image_reconciliation_leases" (
    "lease_name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "image_reconciliation_leases_pkey" PRIMARY KEY ("lease_name")
);

CREATE TABLE "image_reconciliation_metrics" (
    "id" TEXT NOT NULL,
    "orphan_count" INTEGER NOT NULL DEFAULT 0,
    "repaired_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "oldest_pending_age_ms" DOUBLE PRECISION,
    "oldest_deleting_age_ms" DOUBLE PRECISION,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "image_reconciliation_metrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "image_assets_storage_key_key" ON "image_assets"("storage_key");
CREATE UNIQUE INDEX "image_assets_source_event_id_key" ON "image_assets"("source_event_id");
CREATE UNIQUE INDEX "image_assets_delete_event_id_key" ON "image_assets"("delete_event_id");
CREATE UNIQUE INDEX "image_assets_owner_idempotency_key" ON "image_assets"("client_service_id", "idempotency_key");
CREATE UNIQUE INDEX "image_assets_owner_path_name_key" ON "image_assets"("client_service_id", "logical_path", "name");
CREATE INDEX "image_assets_owner_state_created_idx" ON "image_assets"("client_service_id", "status", "created_at");
CREATE INDEX "image_assets_reconciliation_idx" ON "image_assets"("status", "updated_at");
CREATE INDEX "image_assets_ready_reconciliation_idx" ON "image_assets"("status", "last_reconciled_at", "asset_id");
CREATE INDEX "image_assets_ready_unreconciled_idx" ON "image_assets"("status", "last_reconciled_at", "updated_at", "asset_id");
CREATE INDEX "image_assets_deleted_cleanup_idx" ON "image_assets"("status", "deleted_at", "asset_id");
CREATE UNIQUE INDEX "image_variants_storage_key_key" ON "image_variants"("storage_key");
CREATE UNIQUE INDEX "image_variants_asset_spec_key" ON "image_variants"("asset_id", "spec_key");
CREATE INDEX "image_variants_asset_state_idx" ON "image_variants"("asset_id", "status");
CREATE INDEX "image_variants_reconciliation_idx" ON "image_variants"("status", "updated_at");
CREATE INDEX "image_variants_deleted_cleanup_idx" ON "image_variants"("status", "deleted_at", "variant_id");
CREATE UNIQUE INDEX "image_variant_jobs_job_key_key" ON "image_variant_jobs"("job_key");
CREATE INDEX "image_variant_jobs_claim_idx" ON "image_variant_jobs"("status", "next_attempt_at", "lease_expires_at");
CREATE INDEX "image_variant_jobs_asset_state_idx" ON "image_variant_jobs"("asset_id", "status");
CREATE INDEX "image_variant_jobs_publish_idx" ON "image_variant_jobs"("published_at", "next_publish_at");
CREATE UNIQUE INDEX "image_reconciliation_leases_token_key" ON "image_reconciliation_leases"("token");
CREATE INDEX "image_reconciliation_leases_expires_at_idx" ON "image_reconciliation_leases"("expires_at");
