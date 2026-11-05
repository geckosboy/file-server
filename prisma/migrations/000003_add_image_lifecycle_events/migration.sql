-- Store Client Service-facing lifecycle events separately from telemetry events.

CREATE TABLE IF NOT EXISTS image_lifecycle_events (
    id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    source_app TEXT NOT NULL,
    environment TEXT NOT NULL,
    status TEXT NOT NULL,
    occurred_at TIMESTAMP(3) NOT NULL,
    received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    client_service_id TEXT,
    client_service_slug TEXT,
    request_id TEXT,
    trace_id TEXT,
    image_id INTEGER,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    image_key TEXT NOT NULL,
    format TEXT,
    input_bytes INTEGER,
    output_bytes INTEGER,
    duration_ms DOUBLE PRECISION,
    error_code TEXT,
    error_message TEXT,
    raw_payload JSONB NOT NULL,

    CONSTRAINT image_lifecycle_events_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS image_lifecycle_ingestion_metrics (
    id TEXT NOT NULL,
    validation_failure_count INTEGER NOT NULL DEFAULT 0,
    insert_failure_count INTEGER NOT NULL DEFAULT 0,
    last_consumed_event_at TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL,

    CONSTRAINT image_lifecycle_ingestion_metrics_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS image_lifecycle_events_event_id_key ON image_lifecycle_events(event_id);
CREATE INDEX IF NOT EXISTS image_lifecycle_events_client_service_id_occurred_at_idx ON image_lifecycle_events(client_service_id, occurred_at);
CREATE INDEX IF NOT EXISTS image_lifecycle_events_client_service_slug_occurred_at_idx ON image_lifecycle_events(client_service_slug, occurred_at);
CREATE INDEX IF NOT EXISTS image_lifecycle_events_event_type_occurred_at_idx ON image_lifecycle_events(event_type, occurred_at);
CREATE INDEX IF NOT EXISTS image_lifecycle_events_status_occurred_at_idx ON image_lifecycle_events(status, occurred_at);
CREATE INDEX IF NOT EXISTS image_lifecycle_events_image_key_occurred_at_idx ON image_lifecycle_events(image_key, occurred_at);
CREATE INDEX IF NOT EXISTS image_lifecycle_events_request_id_idx ON image_lifecycle_events(request_id);
CREATE INDEX IF NOT EXISTS image_lifecycle_events_trace_id_idx ON image_lifecycle_events(trace_id);

ALTER TABLE image_lifecycle_events
    ADD CONSTRAINT image_lifecycle_events_client_service_id_fkey
    FOREIGN KEY (client_service_id)
    REFERENCES client_services(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
