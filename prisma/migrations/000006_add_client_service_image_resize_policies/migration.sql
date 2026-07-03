CREATE TABLE "client_service_image_resize_policies" (
    "id" TEXT NOT NULL,
    "client_service_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ON_DEMAND',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "client_service_image_resize_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "client_service_image_resize_variants" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "client_service_image_resize_variants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_service_image_resize_policies_client_service_id_key" ON "client_service_image_resize_policies"("client_service_id");
CREATE INDEX "client_service_image_resize_policies_mode_idx" ON "client_service_image_resize_policies"("mode");
CREATE UNIQUE INDEX "client_service_image_resize_variants_policy_size_format_key" ON "client_service_image_resize_variants"("policy_id", "width", "height", "format");
CREATE INDEX "client_service_image_resize_variants_policy_id_idx" ON "client_service_image_resize_variants"("policy_id");
CREATE INDEX "client_service_image_resize_variants_format_idx" ON "client_service_image_resize_variants"("format");
CREATE INDEX "client_service_image_resize_variants_is_enabled_idx" ON "client_service_image_resize_variants"("is_enabled");

ALTER TABLE "client_service_image_resize_policies"
ADD CONSTRAINT "client_service_image_resize_policies_client_service_id_fkey"
FOREIGN KEY ("client_service_id") REFERENCES "client_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_service_image_resize_variants"
ADD CONSTRAINT "client_service_image_resize_variants_policy_id_fkey"
FOREIGN KEY ("policy_id") REFERENCES "client_service_image_resize_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
