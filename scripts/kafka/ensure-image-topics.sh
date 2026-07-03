#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/kafka/ensure-image-topics.sh dev [topic ...]
  scripts/kafka/ensure-image-topics.sh prod [topic ...]

Creates the image service Kafka topics if they do not exist, then describes them.

Default topics:
  image-topic
  file.image.events.v1
  file.image.lifecycle.v1

Environment overrides:
  KAFKA_COMPOSE_FILE              Docker compose file path
  KAFKA_TOPIC_SERVICE             Kafka service name in the compose file
  KAFKA_TOPIC_BOOTSTRAP           Bootstrap server visible inside the Kafka container
  KAFKA_TOPIC_PARTITIONS          Topic partition count
  KAFKA_TOPIC_REPLICATION_FACTOR  Topic replication factor
  KAFKA_TOPIC_MIN_ISR             min.insync.replicas topic config
USAGE
}

mode="${1:-}"
if [[ -z "$mode" || "$mode" == "-h" || "$mode" == "--help" ]]; then
  usage
  exit 0
fi
shift || true

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

case "$mode" in
  dev|local)
    compose_file="${KAFKA_COMPOSE_FILE:-$repo_root/docker/docker-compose.dev.yml}"
    kafka_service="${KAFKA_TOPIC_SERVICE:-kafka}"
    bootstrap_server="${KAFKA_TOPIC_BOOTSTRAP:-localhost:9092}"
    partitions="${KAFKA_TOPIC_PARTITIONS:-3}"
    replication_factor="${KAFKA_TOPIC_REPLICATION_FACTOR:-1}"
    min_isr="${KAFKA_TOPIC_MIN_ISR:-1}"
    ;;
  prod|production)
    compose_file="${KAFKA_COMPOSE_FILE:-$repo_root/docker/docker-compose.kafka.yml}"
    kafka_service="${KAFKA_TOPIC_SERVICE:-kafka-broker-1}"
    bootstrap_server="${KAFKA_TOPIC_BOOTSTRAP:-kafka-broker-1:9092}"
    partitions="${KAFKA_TOPIC_PARTITIONS:-6}"
    replication_factor="${KAFKA_TOPIC_REPLICATION_FACTOR:-3}"
    min_isr="${KAFKA_TOPIC_MIN_ISR:-2}"
    ;;
  *)
    echo "Unknown mode: $mode" >&2
    usage >&2
    exit 64
    ;;
esac

topics=("$@")
if [[ ${#topics[@]} -eq 0 ]]; then
  topics=(
    image-topic
    file.image.events.v1
    file.image.lifecycle.v1
  )
fi

if [[ ! -f "$compose_file" ]]; then
  echo "Compose file not found: $compose_file" >&2
  exit 66
fi

compose=(docker compose -f "$compose_file")
kafka_topics=(/opt/kafka/bin/kafka-topics.sh --bootstrap-server "$bootstrap_server")

echo "Kafka topic bootstrap"
echo "  mode: $mode"
echo "  compose: $compose_file"
echo "  service: $kafka_service"
echo "  bootstrap: $bootstrap_server"
echo "  partitions: $partitions"
echo "  replicationFactor: $replication_factor"
echo "  min.insync.replicas: $min_isr"
echo

"${compose[@]}" exec -T "$kafka_service" \
  /opt/kafka/bin/kafka-broker-api-versions.sh \
  --bootstrap-server "$bootstrap_server" >/dev/null

for topic in "${topics[@]}"; do
  echo "Ensuring topic: $topic"
  "${compose[@]}" exec -T "$kafka_service" \
    "${kafka_topics[@]}" \
    --create \
    --if-not-exists \
    --topic "$topic" \
    --partitions "$partitions" \
    --replication-factor "$replication_factor" \
    --config "min.insync.replicas=$min_isr"
done

echo
echo "Topic descriptions"
for topic in "${topics[@]}"; do
  "${compose[@]}" exec -T "$kafka_service" \
    "${kafka_topics[@]}" \
    --describe \
    --topic "$topic"
done
