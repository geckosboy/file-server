#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
compose_file="$repo_root/docker/docker-compose.kafka-acl-e2e.yml"
project="${KAFKA_ACL_E2E_PROJECT:-fs-kafka-acl-e2e-$$}"
config_dir="$(mktemp -d)"
export KAFKA_ACL_E2E_PROJECT="$project"
export KAFKA_ACL_E2E_CONFIG_DIR="$config_dir"

compose=(docker compose -f "$compose_file" -p "$project")
admin=("${compose[@]}" exec -T kafka)
bootstrap=kafka:9092
canonical_topic=file.image.lifecycle.v1
client_a_topic=file.image.lifecycle.client.client-a.v1
client_b_topic=file.image.lifecycle.client.client-b.v1
client_a_group=file-lifecycle-client-a-e2e
variant_topic=file.image.variant.jobs.v1
variant_dlq_topic=file.image.variant.jobs.v1.dlq
invalidation_topic=file.image.cache-invalidation.v1
invalidation_dlq_topic=file.image.cache-invalidation.v1.dlq
storage_group=file-image-variant-worker-v1
cache_group=file-cache-invalidation-v1-e2e

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$config_dir"
}
trap cleanup EXIT INT TERM

write_client_config() {
  local file="$1"
  local username="$2"
  local password="$3"
  cat >"$config_dir/$file" <<EOF
security.protocol=SASL_PLAINTEXT
sasl.mechanism=PLAIN
sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="$username" password="$password";
EOF
}

write_client_config admin.properties admin admin-secret
write_client_config client-a.properties client_a client-a-secret
write_client_config client-b.properties client_b client-b-secret
write_client_config storage.properties storage storage-secret
write_client_config cache.properties cache cache-secret

echo 'Starting isolated Kafka authorization broker'
"${compose[@]}" up --detach --wait --wait-timeout 120

for topic in \
  "$canonical_topic" \
  "$client_a_topic" \
  "$client_b_topic" \
  "$variant_topic" \
  "$variant_dlq_topic" \
  "$invalidation_topic" \
  "$invalidation_dlq_topic"; do
  "${admin[@]}" /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server "$bootstrap" \
    --command-config /etc/kafka/client-config/admin.properties \
    --create \
    --if-not-exists \
    --topic "$topic" \
    --partitions 1 \
    --replication-factor 1 >/dev/null
done

add_topic_acl() {
  local principal="$1"
  local operation="$2"
  local topic="$3"
  "${admin[@]}" /opt/kafka/bin/kafka-acls.sh \
    --bootstrap-server "$bootstrap" \
    --command-config /etc/kafka/client-config/admin.properties \
    --add \
    --allow-principal "User:$principal" \
    --operation "$operation" \
    --operation DESCRIBE \
    --topic "$topic" >/dev/null
}

add_group_acl() {
  local principal="$1"
  local group="$2"
  "${admin[@]}" /opt/kafka/bin/kafka-acls.sh \
    --bootstrap-server "$bootstrap" \
    --command-config /etc/kafka/client-config/admin.properties \
    --add \
    --allow-principal "User:$principal" \
    --operation READ \
    --group "$group" >/dev/null
}

"${admin[@]}" /opt/kafka/bin/kafka-acls.sh \
  --bootstrap-server "$bootstrap" \
  --command-config /etc/kafka/client-config/admin.properties \
  --add \
  --allow-principal User:client_a \
  --operation READ \
  --operation DESCRIBE \
  --topic "$client_a_topic" >/dev/null
"${admin[@]}" /opt/kafka/bin/kafka-acls.sh \
  --bootstrap-server "$bootstrap" \
  --command-config /etc/kafka/client-config/admin.properties \
  --add \
  --allow-principal User:client_a \
  --operation READ \
  --group "$client_a_group" >/dev/null

# Storage publishes durable jobs, consumes them in one fixed worker group, and
# publishes poison envelopes plus cache invalidations after durable outcomes.
add_topic_acl storage WRITE "$variant_topic"
add_topic_acl storage READ "$variant_topic"
add_topic_acl storage WRITE "$variant_dlq_topic"
add_topic_acl storage WRITE "$invalidation_topic"
add_group_acl storage "$storage_group"

# Each cache replica consumes the canonical invalidation stream in its own
# group and may publish only poison envelopes to the invalidation DLQ.
add_topic_acl cache READ "$invalidation_topic"
add_topic_acl cache WRITE "$invalidation_dlq_topic"
add_group_acl cache "$cache_group"

for topic in \
  "$canonical_topic" \
  "$client_a_topic" \
  "$client_b_topic"; do
  printf '{"topic":"%s","eventId":"acl-e2e"}\n' "$topic" | \
    "${admin[@]}" /opt/kafka/bin/kafka-console-producer.sh \
      --bootstrap-server "$bootstrap" \
      --producer.config /etc/kafka/client-config/admin.properties \
      --topic "$topic" >/dev/null
done

produce_as() {
  local config="$1"
  local topic="$2"
  local marker="$3"
  printf '{"topic":"%s","eventId":"%s"}\n' "$topic" "$marker" | \
    "${admin[@]}" /opt/kafka/bin/kafka-console-producer.sh \
      --bootstrap-server "$bootstrap" \
      --producer.config "/etc/kafka/client-config/$config" \
      --topic "$topic" >/dev/null
}

consume_as() {
  local config="$1"
  local topic="$2"
  local group="$3"
  local marker="$4"
  local output
  output="$("${admin[@]}" /opt/kafka/bin/kafka-console-consumer.sh \
    --bootstrap-server "$bootstrap" \
    --consumer.config "/etc/kafka/client-config/$config" \
    --topic "$topic" \
    --group "$group" \
    --from-beginning \
    --max-messages 1 \
    --timeout-ms 15000 2>&1)"
  grep -F "\"eventId\":\"$marker\"" <<<"$output" >/dev/null
}

echo 'Proving storage image lifecycle job and invalidation grants'
produce_as storage.properties "$variant_topic" image-lifecycle-storage-variant
consume_as storage.properties "$variant_topic" "$storage_group" image-lifecycle-storage-variant
produce_as storage.properties "$variant_dlq_topic" image-lifecycle-storage-variant-dlq
produce_as storage.properties "$invalidation_topic" image-lifecycle-storage-invalidation

echo 'Proving cache invalidation and DLQ grants'
consume_as cache.properties "$invalidation_topic" "$cache_group" image-lifecycle-storage-invalidation
produce_as cache.properties "$invalidation_dlq_topic" image-lifecycle-cache-dlq

echo 'Proving client A can consume its own topic'
allowed_output="$("${admin[@]}" /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server "$bootstrap" \
  --consumer.config /etc/kafka/client-config/client-a.properties \
  --topic "$client_a_topic" \
  --group "$client_a_group" \
  --from-beginning \
  --max-messages 1 \
  --timeout-ms 15000 2>&1)"
grep -F '"topic":"file.image.lifecycle.client.client-a.v1"' <<<"$allowed_output" >/dev/null

expect_consume_denied() {
  local config="$1"
  local group="$2"
  local topic="$3"
  local output
  local status
  set +e
  output="$("${admin[@]}" /opt/kafka/bin/kafka-console-consumer.sh \
    --bootstrap-server "$bootstrap" \
    --consumer.config "/etc/kafka/client-config/$config" \
    --topic "$topic" \
    --group "$group" \
    --from-beginning \
    --max-messages 1 \
    --timeout-ms 8000 2>&1)"
  status=$?
  set -e
  if grep -F '"eventId":"acl-e2e"' <<<"$output" >/dev/null; then
    echo "Expected authorization denial for $topic, but an event was consumed" >&2
    exit 1
  fi
  if ! grep -Eqi 'TopicAuthorizationException|not authorized|authorization failed' <<<"$output"; then
    echo "Expected authorization error for $topic (status=$status), got:" >&2
    echo "$output" >&2
    exit 1
  fi
  echo "Denied as expected: $topic"
}

expect_produce_denied() {
  local config="$1"
  local topic="$2"
  local output
  local status
  set +e
  output="$(printf '{"eventId":"acl-denied"}\n' | \
    "${admin[@]}" /opt/kafka/bin/kafka-console-producer.sh \
      --bootstrap-server "$bootstrap" \
      --producer.config "/etc/kafka/client-config/$config" \
      --topic "$topic" 2>&1)"
  status=$?
  set -e
  if ! grep -Eqi 'TopicAuthorizationException|not authorized|authorization failed' <<<"$output"; then
    echo "Expected produce authorization error for $topic (status=$status), got:" >&2
    echo "$output" >&2
    exit 1
  fi
  echo "Produce denied as expected: $topic"
}

expect_consume_denied client-a.properties "$client_a_group" "$client_b_topic"
expect_consume_denied client-a.properties "$client_a_group" "$canonical_topic"
expect_consume_denied client-a.properties "$client_a_group" "$variant_topic"
expect_consume_denied cache.properties "$cache_group" "$variant_topic"
expect_consume_denied storage.properties "$storage_group" "$invalidation_topic"
expect_produce_denied cache.properties "$invalidation_topic"
expect_produce_denied client-a.properties "$variant_topic"

echo 'Kafka ACL isolation assertions passed; cleaning infrastructure'
cleanup
trap - EXIT INT TERM
if [[ -n "$("${compose[@]}" ps --quiet 2>/dev/null)" ]]; then
  echo 'Kafka ACL E2E cleanup left running containers' >&2
  exit 1
fi
if [[ -n "$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")" ]]; then
  echo 'Kafka ACL E2E cleanup left volumes' >&2
  exit 1
fi
if [[ -n "$(docker network ls --quiet --filter "label=com.docker.compose.project=$project")" ]]; then
  echo 'Kafka ACL E2E cleanup left networks' >&2
  exit 1
fi
echo 'Kafka ACL isolation E2E: PASS'
