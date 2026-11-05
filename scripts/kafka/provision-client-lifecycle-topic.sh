#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  KAFKA_CLIENT_PRINCIPAL_PASSWORD=... scripts/kafka/provision-client-lifecycle-topic.sh prod <client-service-id> <consumer-group>

Creates the server-computed client lifecycle topic, provisions a SCRAM-SHA-512
credential, and grants only READ/DESCRIBE on that topic plus READ on the exact
consumer group. The canonical topic receives no client ACL.

Environment overrides:
  KAFKA_COMPOSE_FILE
  KAFKA_TOPIC_SERVICE
  KAFKA_TOPIC_BOOTSTRAP
  KAFKA_TOPIC_COMMAND_CONFIG
  KAFKA_CLIENT_PRINCIPAL_PASSWORD (required)
USAGE
}

mode="${1:-}"
client_service_id="${2:-}"
consumer_group="${3:-}"
if [[ "$mode" != "prod" && "$mode" != "production" ]] || [[ -z "$client_service_id" || -z "$consumer_group" ]]; then
  usage >&2
  exit 64
fi
if [[ ! "$client_service_id" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
  echo "Unsafe client service id" >&2
  exit 65
fi
if [[ ! "$consumer_group" =~ ^[A-Za-z0-9._-]{2,128}$ ]]; then
  echo "Unsafe consumer group" >&2
  exit 65
fi
if [[ -z "${KAFKA_CLIENT_PRINCIPAL_PASSWORD:-}" ]]; then
  echo "KAFKA_CLIENT_PRINCIPAL_PASSWORD is required" >&2
  exit 78
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
compose_file="${KAFKA_COMPOSE_FILE:-$repo_root/docker/docker-compose.kafka.yml}"
kafka_service="${KAFKA_TOPIC_SERVICE:-kafka-broker-1}"
bootstrap_server="${KAFKA_TOPIC_BOOTSTRAP:-kafka-broker-1:9092}"
command_config="${KAFKA_TOPIC_COMMAND_CONFIG:-/etc/kafka/secrets/broker-admin.properties}"
normalized_id="$(printf '%s' "$client_service_id" | tr '[:upper:]' '[:lower:]')"
topic="file.image.lifecycle.client.${normalized_id}.v1"
username="file-lifecycle-${normalized_id}"
principal="User:${username}"
compose=(docker compose -f "$compose_file")
exec_kafka=("${compose[@]}" exec -T "$kafka_service")
command_config_args=(--command-config "$command_config")

KAFKA_COMPOSE_FILE="$compose_file" \
KAFKA_TOPIC_SERVICE="$kafka_service" \
KAFKA_TOPIC_BOOTSTRAP="$bootstrap_server" \
KAFKA_TOPIC_COMMAND_CONFIG="$command_config" \
  "$script_dir/ensure-image-topics.sh" prod "$topic"

"${exec_kafka[@]}" /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server "$bootstrap_server" \
  "${command_config_args[@]}" \
  --alter \
  --entity-type users \
  --entity-name "$username" \
  --add-config "SCRAM-SHA-512=[iterations=8192,password=${KAFKA_CLIENT_PRINCIPAL_PASSWORD}]"

"${exec_kafka[@]}" /opt/kafka/bin/kafka-acls.sh \
  --bootstrap-server "$bootstrap_server" \
  "${command_config_args[@]}" \
  --add \
  --allow-principal "$principal" \
  --operation READ \
  --operation DESCRIBE \
  --topic "$topic"

"${exec_kafka[@]}" /opt/kafka/bin/kafka-acls.sh \
  --bootstrap-server "$bootstrap_server" \
  "${command_config_args[@]}" \
  --add \
  --allow-principal "$principal" \
  --operation READ \
  --group "$consumer_group"

echo "Provisioned lifecycle consumer"
echo "  topic: $topic"
echo "  username: $username"
echo "  consumerGroup: $consumer_group"
