#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
subject="$repo_root/scripts/kafka/ensure-image-topics.sh"
provisioner="$repo_root/scripts/kafka/provision-client-lifecycle-topic.sh"

bash -n "$subject" "$provisioner"
test -x "$subject"
test -x "$provisioner"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
touch "$tmp_dir/compose.yml"
cat >"$tmp_dir/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_STUB_LOG"
STUB
chmod +x "$tmp_dir/docker"

export DOCKER_STUB_LOG="$tmp_dir/docker.log"
PATH="$tmp_dir:$PATH" \
KAFKA_COMPOSE_FILE="$tmp_dir/compose.yml" \
KAFKA_TOPIC_COMMAND_CONFIG=/run/secrets/admin.properties \
  "$subject" prod

grep -F -- '--command-config /run/secrets/admin.properties' "$DOCKER_STUB_LOG" >/dev/null
for topic in \
  file.image.events.v1 \
  file.image.events.v1.dlq \
  file.image.lifecycle.v1 \
  file.image.lifecycle.v1.dlq \
  file.image.variant.jobs.v1 \
  file.image.variant.jobs.v1.dlq \
  file.image.cache-invalidation.v1 \
  file.image.cache-invalidation.v1.dlq; do
  grep -F -- "--topic $topic" "$DOCKER_STUB_LOG" >/dev/null
done

echo 'Kafka topic scripts: PASS'
