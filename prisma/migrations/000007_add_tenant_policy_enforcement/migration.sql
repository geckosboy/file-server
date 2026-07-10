-- Stage 1: replica-safe request rate limits and durable control-plane audit logs.

CREATE TABLE "client_service_rate_limit_windows" (
    "client_service_id" TEXT NOT NULL,
    "client_service_key_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "window_started_at" TIMESTAMPTZ NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "client_service_rate_limit_windows_pkey"
        PRIMARY KEY ("client_service_key_id", "action", "window_started_at")
);

CREATE INDEX "client_service_rate_limit_windows_service_window_idx"
    ON "client_service_rate_limit_windows"("client_service_id", "window_started_at");
CREATE INDEX "client_service_rate_limit_windows_window_started_at_idx"
    ON "client_service_rate_limit_windows"("window_started_at");

ALTER TABLE "client_service_rate_limit_windows"
    ADD CONSTRAINT "client_service_rate_limit_windows_client_service_id_fkey"
    FOREIGN KEY ("client_service_id") REFERENCES "client_services"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_service_rate_limit_windows"
    ADD CONSTRAINT "client_service_rate_limit_windows_client_service_key_id_fkey"
    FOREIGN KEY ("client_service_key_id") REFERENCES "client_service_keys"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "client_service_id" TEXT,
    "actor" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_logs_client_service_created_at_idx"
    ON "admin_audit_logs"("client_service_id", "created_at");
CREATE INDEX "admin_audit_logs_actor_created_at_idx"
    ON "admin_audit_logs"("actor", "created_at");
CREATE INDEX "admin_audit_logs_request_id_idx"
    ON "admin_audit_logs"("request_id");

ALTER TABLE "admin_audit_logs"
    ADD CONSTRAINT "admin_audit_logs_client_service_id_fkey"
    FOREIGN KEY ("client_service_id") REFERENCES "client_services"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
