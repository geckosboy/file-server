-- Manage which lifecycle events each Client Service consumes.

CREATE TABLE IF NOT EXISTS client_service_lifecycle_subscriptions (
    id TEXT NOT NULL,
    client_service_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    consumer_group TEXT NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    description TEXT,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP(3) NOT NULL,

    CONSTRAINT client_service_lifecycle_subscriptions_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS client_service_lifecycle_subscriptions_service_event_group_key
    ON client_service_lifecycle_subscriptions(client_service_id, event_type, consumer_group);
CREATE INDEX IF NOT EXISTS client_service_lifecycle_subscriptions_client_service_id_idx
    ON client_service_lifecycle_subscriptions(client_service_id);
CREATE INDEX IF NOT EXISTS client_service_lifecycle_subscriptions_event_type_idx
    ON client_service_lifecycle_subscriptions(event_type);
CREATE INDEX IF NOT EXISTS client_service_lifecycle_subscriptions_consumer_group_idx
    ON client_service_lifecycle_subscriptions(consumer_group);
CREATE INDEX IF NOT EXISTS client_service_lifecycle_subscriptions_is_enabled_idx
    ON client_service_lifecycle_subscriptions(is_enabled);

ALTER TABLE client_service_lifecycle_subscriptions
    ADD CONSTRAINT client_service_lifecycle_subscriptions_client_service_id_fkey
    FOREIGN KEY (client_service_id)
    REFERENCES client_services(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE;
