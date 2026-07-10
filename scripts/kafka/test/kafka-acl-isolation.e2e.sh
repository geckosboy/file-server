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

echo 'Starting isolated Kafka authorization broker'
"${compose[@]}" up --detach --wait --wait-timeout 120

for topic in "$canonical_topic" "$client_a_topic" "$client_b_topic"; do
  "${admin[@]}" /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server "$bootstrap" \
    --command-config /etc/kafka/client-config/admin.properties \
    --create \
    --if-not-exists \
    --topic "$topic" \
    --partitions 1 \
    --replication-factor 1 >/dev/null
done

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

for topic in "$canonical_topic" "$client_a_topic" "$client_b_topic"; do
  printf '{"topic":"%s","eventId":"acl-e2e"}\n' "$topic" | \
    "${admin[@]}" /opt/kafka/bin/kafka-console-producer.sh \
      --bootstrap-server "$bootstrap" \
      --producer.config /etc/kafka/client-config/admin.properties \
      --topic "$topic" >/dev/null
done

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

expect_topic_denied() {
  local topic="$1"
  local output
  local status
  set +e
  output="$("${admin[@]}" /opt/kafka/bin/kafka-console-consumer.sh \
    --bootstrap-server "$bootstrap" \
    --consumer.config /etc/kafka/client-config/client-a.properties \
    --topic "$topic" \
    --group "$client_a_group" \
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

expect_topic_denied "$client_b_topic"
expect_topic_denied "$canonical_topic"

echo 'Kafka ACL isolation assertions passed; cleaning infrastructure'
cleanup
trap - EXIT INT TERM
if [[ -n "$("${compose[@]}" ps --quiet 2>/dev/null)" ]]; then
  echo 'Kafka ACL E2E cleanup left running containers' >&2
  exit 1
fi
echo 'Kafka ACL isolation E2E: PASS'
