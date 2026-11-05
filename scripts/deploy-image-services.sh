#!/usr/bin/env bash
set -Eeuo pipefail

readonly RUNTIME_SERVICES=(storage resize cache)
readonly ADMIN_SERVICES=(telemetry-api admin-web)
declare -a SERVICES=()
readonly CONTAINER_PREFIX=file_server
SCHEMA_SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-deployment-schema.cjs"
readonly SCHEMA_SCRIPT_PATH
REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPOSITORY_ROOT
readonly STORAGE_ASSETS_PATH=/usr/index/apps/storage/dist/apps/storage/assets

declare -a OLD_EXISTS OLD_RUNNING OLD_STOPPED CANDIDATE_CREATED BACKUP_CREATED NEW_CANONICAL
DEPLOY_SUCCEEDED=0
ROLLBACK_STARTED=0
MUTATION_STARTED=0
DEPLOY_RUNTIME=0
DEPLOY_ADMIN=0

log() { printf '[deploy] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

required_value() {
	local name=$1
	[[ -n ${!name:-} ]] || fail "$name is required"
}

configure_services() {
	local configured_groups=${DEPLOY_GROUPS-runtime}
	[[ -n $configured_groups ]] || fail 'DEPLOY_GROUPS must not be empty'
	[[ $configured_groups != ,* && $configured_groups != *, && $configured_groups != *,,* ]] || \
		fail 'DEPLOY_GROUPS contains an empty group'

	local group
	local -a groups=()
	IFS=',' read -r -a groups <<<"$configured_groups"
	for group in "${groups[@]}"; do
		[[ -n $group ]] || fail 'DEPLOY_GROUPS contains an empty group'
		case $group in
			runtime)
				(( DEPLOY_RUNTIME == 0 )) || fail "DEPLOY_GROUPS contains duplicate group: $group"
				DEPLOY_RUNTIME=1
				;;
			admin)
				(( DEPLOY_ADMIN == 0 )) || fail "DEPLOY_GROUPS contains duplicate group: $group"
				DEPLOY_ADMIN=1
				;;
			*) fail "DEPLOY_GROUPS contains unknown group: $group" ;;
		esac
	done
	[[ $configured_groups != admin,runtime ]] || fail 'DEPLOY_GROUPS must use canonical runtime,admin order'

	if (( DEPLOY_RUNTIME == 1 )); then SERVICES+=("${RUNTIME_SERVICES[@]}"); fi
	if (( DEPLOY_ADMIN == 1 )); then SERVICES+=("${ADMIN_SERVICES[@]}"); fi
	((${#SERVICES[@]} > 0)) || fail 'DEPLOY_GROUPS must select at least one group'
}

env_value() {
	local file=$1 name=$2 value non_whitespace
	if ! value=$(
		awk -v name="$name" '
			$0 ~ "^[[:space:]]*" name "[[:space:]]*=" {
				count++
				line = $0
				sub("^[[:space:]]*" name "[[:space:]]*=", "", line)
				value = line
			}
			END {
				if (count != 1) exit 42
				print value
			}
		' "$file"
	); then
		fail "$file must define $name exactly once"
	fi
	value=${value%$'\r'}
	non_whitespace=${value//[[:space:]]/}
	[[ -n $non_whitespace ]] || fail "$file must define a non-empty $name"
	printf '%s' "$value"
}

env_declares() {
	local file=$1 name=$2
	awk -v name="$name" '
		$0 ~ "^[[:space:]]*" name "([[:space:]]*=.*)?[[:space:]]*$" { found = 1 }
		END { exit found ? 0 : 1 }
	' "$file"
}

image_for() {
	case $1 in
		storage) printf '%s' "$STORAGE_IMAGE" ;;
		resize) printf '%s' "$RESIZE_IMAGE" ;;
		cache) printf '%s' "$CACHE_IMAGE" ;;
		telemetry-api) printf '%s' "$TELEMETRY_API_IMAGE" ;;
		admin-web) printf '%s' "$ADMIN_WEB_IMAGE" ;;
	esac
}

env_path_for() {
	case $1 in
		storage) printf '%s' "$STORAGE_ENV_PATH" ;;
		resize) printf '%s' "$RESIZE_ENV_PATH" ;;
		cache) printf '%s' "$CACHE_ENV_PATH" ;;
		telemetry-api) printf '%s' "$TELEMETRY_API_ENV_PATH" ;;
		admin-web) printf '%s' "$ADMIN_WEB_ENV_PATH" ;;
	esac
}

port_for() {
	case $1 in
		storage) printf '%s' "$STORAGE_PORT" ;;
		resize) printf '%s' "$RESIZE_PORT" ;;
		cache) printf '%s' "$CACHE_PORT" ;;
		telemetry-api) printf '%s' "$TELEMETRY_API_PORT" ;;
		admin-web) printf '%s' "$ADMIN_WEB_PORT" ;;
	esac
}

service_uses_kafka() {
	[[ $1 != admin-web ]]
}

container_exists() {
	docker inspect --type container "$1" >/dev/null 2>&1
}

cleanup_candidate() {
	local index=$1
	local service=${SERVICES[$index]}
	local candidate="${CONTAINER_PREFIX}_${service}_candidate_${DEPLOY_RUN_ID}"
	if [[ ${CANDIDATE_CREATED[$index]:-0} == 1 ]] && container_exists "$candidate"; then
		docker rm -f "$candidate" >/dev/null 2>&1 || log "ERROR: could not remove candidate $candidate"
	fi
}

rollback() {
	local exit_code=$1
	(( ROLLBACK_STARTED == 0 )) || return 0
	ROLLBACK_STARTED=1
	trap - EXIT INT TERM
	log "Deployment failed (exit $exit_code); rolling back every mutated service."

	local index service canonical backup
	for ((index=${#SERVICES[@]} - 1; index >= 0; index--)); do
		service=${SERVICES[$index]}
		canonical="${CONTAINER_PREFIX}_${service}"
		backup="${canonical}_backup_${DEPLOY_RUN_ID}"
		if [[ ${NEW_CANONICAL[$index]:-0} == 1 ]] && container_exists "$canonical"; then
			docker stop "$canonical" >/dev/null 2>&1 || true
			docker rm -f "$canonical" >/dev/null 2>&1 || log "ERROR: could not remove failed $canonical"
		fi
		if [[ ${BACKUP_CREATED[$index]:-0} == 1 ]] && container_exists "$backup"; then
			if docker rename "$backup" "$canonical" >/dev/null 2>&1; then
				if [[ ${OLD_RUNNING[$index]:-0} == 1 ]]; then
					docker start "$canonical" >/dev/null 2>&1 || log "ERROR: could not restart restored $canonical"
				fi
			else
				log "ERROR: could not restore $backup to $canonical"
			fi
		elif [[ ${OLD_STOPPED[$index]:-0} == 1 && ${OLD_RUNNING[$index]:-0} == 1 ]]; then
			if container_exists "$canonical"; then
				docker start "$canonical" >/dev/null 2>&1 || log "ERROR: could not restart $canonical"
			fi
		fi
		cleanup_candidate "$index"
	done

	local running port
	for index in "${!SERVICES[@]}"; do
		service=${SERVICES[$index]}
		canonical="${CONTAINER_PREFIX}_${service}"
		backup="${canonical}_backup_${DEPLOY_RUN_ID}"
		container_exists "$backup" && log "ERROR: rollback left backup name $backup"
		if [[ ${OLD_EXISTS[$index]:-0} == 1 ]]; then
			if ! container_exists "$canonical"; then
				log "ERROR: rollback did not restore $canonical"
				continue
			fi
			running=$(docker inspect --type container --format '{{.State.Running}}' "$canonical" 2>/dev/null || printf unknown)
			if [[ ${OLD_RUNNING[$index]:-0} == 1 ]]; then
				if [[ $running != true ]]; then
					log "ERROR: restored $canonical is not running"
					continue
				fi
				port=$(port_for "$service")
				curl --fail --silent --show-error --connect-timeout 1 --max-time 3 \
					"http://127.0.0.1:${port}/health/ready" >/dev/null 2>&1 || \
					log "ERROR: restored $canonical failed /health/ready"
			elif [[ $running != false ]]; then
				log "ERROR: restored $canonical did not return to its stopped state"
			fi
		elif container_exists "$canonical"; then
			log "ERROR: rollback left new container $canonical from a first deployment"
		fi
	done
	log "Rollback attempts and restoration checks finished; any ERROR above means restoration is unverified."
}

on_exit() {
	local exit_code=$?
	if (( exit_code != 0 && DEPLOY_SUCCEEDED == 0 && MUTATION_STARTED == 1 )); then rollback "$exit_code"; fi
	exit "$exit_code"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

validate_inputs() {
	configure_services
	local name service image env_path port existing_port database_url
	local selected_database_url='' database_initialized=0
	for name in FILE_SERVER_NET DEPLOY_RUN_ID; do
		required_value "$name"
	done
	if (( DEPLOY_RUNTIME == 1 )); then
		for name in STORAGE_IMAGE RESIZE_IMAGE CACHE_IMAGE STORAGE_ENV_PATH RESIZE_ENV_PATH CACHE_ENV_PATH STORAGE_PORT RESIZE_PORT CACHE_PORT FILE_DUMP_VOLUME KAFKA_NET; do
			required_value "$name"
		done
	fi
	if (( DEPLOY_ADMIN == 1 )); then
		for name in TELEMETRY_API_IMAGE ADMIN_WEB_IMAGE TELEMETRY_API_ENV_PATH ADMIN_WEB_ENV_PATH TELEMETRY_API_PORT ADMIN_WEB_PORT KAFKA_NET; do
			required_value "$name"
		done
	fi
	[[ $DEPLOY_RUN_ID =~ ^[0-9]+(-[0-9]+)*$ ]] || fail 'DEPLOY_RUN_ID must contain numeric components separated by hyphens'
	if (( DEPLOY_RUNTIME == 1 )); then
		[[ $FILE_DUMP_VOLUME == file_dump_volume ]] || fail 'FILE_DUMP_VOLUME must be file_dump_volume'
	fi
	[[ $FILE_SERVER_NET != "$KAFKA_NET" ]] || fail 'FILE_SERVER_NET and KAFKA_NET must be different networks'
	local -a selected_ports=()
	for service in "${SERVICES[@]}"; do
		image=$(image_for "$service")
		env_path=$(env_path_for "$service")
		port=$(port_for "$service")
		[[ $image =~ ^ghcr\.io/[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || fail "$service image must be an immutable ghcr.io digest"
		[[ -f $env_path && -r $env_path ]] || fail "$service env path must be a readable file"
		if [[ $service != admin-web ]]; then
			database_url=$(env_value "$env_path" DATABASE_URL)
			if (( database_initialized == 0 )); then
				selected_database_url=$database_url
				database_initialized=1
			else
				[[ $database_url == "$selected_database_url" ]] || fail 'all selected DB-backed services must use the same DATABASE_URL'
			fi
		fi
		if ! [[ $port =~ ^[0-9]+$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
			fail "$service port must be between 1 and 65535"
		fi
		if ((${#selected_ports[@]} > 0)); then
			for existing_port in "${selected_ports[@]}"; do
				[[ $port != "$existing_port" ]] || fail 'service ports must be unique'
			done
		fi
		selected_ports+=("$port")
	done
	if (( DEPLOY_ADMIN == 1 )); then
		local telemetry_token admin_token admin_base_url proxy_secret proxy_secret_bytes
		telemetry_token=$(env_value "$TELEMETRY_API_ENV_PATH" TELEMETRY_ADMIN_TOKEN)
		admin_token=$(env_value "$ADMIN_WEB_ENV_PATH" TELEMETRY_ADMIN_TOKEN)
		[[ $telemetry_token == "$admin_token" ]] || fail 'telemetry-api and admin-web TELEMETRY_ADMIN_TOKEN values must match'
		proxy_secret=$(env_value "$ADMIN_WEB_ENV_PATH" ADMIN_WEB_PROXY_SECRET)
		proxy_secret_bytes=$(printf '%s' "$proxy_secret" | LC_ALL=C wc -c)
		(( proxy_secret_bytes >= 1 && proxy_secret_bytes <= 128 )) || fail 'admin-web ADMIN_WEB_PROXY_SECRET must be between 1 and 128 bytes'
		admin_base_url=$(env_value "$ADMIN_WEB_ENV_PATH" TELEMETRY_API_BASE_URL)
		[[ $admin_base_url == "http://file_server_telemetry-api:${TELEMETRY_API_PORT}/api/admin" ]] || fail 'admin-web TELEMETRY_API_BASE_URL must use the private telemetry-api container address'
		if env_declares "$ADMIN_WEB_ENV_PATH" NEXT_PUBLIC_TELEMETRY_API_BASE_URL; then
			fail 'admin-web env must not declare NEXT_PUBLIC_TELEMETRY_API_BASE_URL'
		fi
	fi
	[[ ${DEPLOY_READY_TIMEOUT_SECONDS:-90} =~ ^[0-9]+$ ]] || fail 'DEPLOY_READY_TIMEOUT_SECONDS must be numeric'
	(( 10#${DEPLOY_READY_TIMEOUT_SECONDS:-90} >= 1 && 10#${DEPLOY_READY_TIMEOUT_SECONDS:-90} <= 90 )) || fail 'DEPLOY_READY_TIMEOUT_SECONDS must be between 1 and 90'
	command -v docker >/dev/null || fail 'docker is required'
	command -v curl >/dev/null || fail 'curl is required'
	[[ -r $SCHEMA_SCRIPT_PATH ]] || fail 'schema verification script is not readable'
}

preflight_runtime() {
	docker network inspect "$FILE_SERVER_NET" >/dev/null || fail "FILE_SERVER_NET does not exist"
	docker network inspect "$KAFKA_NET" >/dev/null || fail "KAFKA_NET does not exist"
	if (( DEPLOY_RUNTIME == 1 )); then
		docker volume inspect "$FILE_DUMP_VOLUME" >/dev/null || fail 'required storage volume does not exist; refusing an empty-data deployment'
	fi

	local index service canonical candidate backup running image platform
	for index in "${!SERVICES[@]}"; do
		service=${SERVICES[$index]}
		canonical="${CONTAINER_PREFIX}_${service}"
		candidate="${canonical}_candidate_${DEPLOY_RUN_ID}"
		backup="${canonical}_backup_${DEPLOY_RUN_ID}"
		container_exists "$candidate" && fail "candidate name already exists: $candidate"
		container_exists "$backup" && fail "backup name already exists: $backup"
		if container_exists "$canonical"; then
			OLD_EXISTS[index]=1
			running=$(docker inspect --type container --format '{{.State.Running}}' "$canonical")
			[[ $running == true || $running == false ]] || fail "could not determine state of $canonical"
			if [[ $running == true ]]; then OLD_RUNNING[index]=1; else OLD_RUNNING[index]=0; fi
		else
			OLD_EXISTS[index]=0
			OLD_RUNNING[index]=0
		fi
		image=$(image_for "$service")
		docker pull "$image" >/dev/null
		platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
		[[ $platform == linux/amd64 ]] || fail "${service} image platform is $platform, expected linux/amd64"
	done
}

verify_schema() {
	local expected_migrations schema_image schema_env schema_script_target
	expected_migrations=$(find "$REPOSITORY_ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort | paste -sd, -)
	[[ -n $expected_migrations ]] || fail 'no checked-out Prisma migrations were found'
	if (( DEPLOY_RUNTIME == 1 )); then
		schema_image=$STORAGE_IMAGE
		schema_env=$STORAGE_ENV_PATH
		schema_script_target=/usr/index/apps/storage/verify-deployment-schema.cjs
	else
		schema_image=$TELEMETRY_API_IMAGE
		schema_env=$TELEMETRY_API_ENV_PATH
		schema_script_target=/usr/index/apps/telemetry-api/verify-deployment-schema.cjs
	fi
	log 'Verifying applied migrations and online backfill indexes (read-only).'
	docker run --rm \
		--network "$FILE_SERVER_NET" \
		--env-file "$schema_env" \
		--env "EXPECTED_MIGRATIONS=$expected_migrations" \
		--volume "$SCHEMA_SCRIPT_PATH:$schema_script_target:ro" \
		"$schema_image" \
		node "$schema_script_target"
}

prepare_candidates() {
	local index service candidate env_path port image
	for index in "${!SERVICES[@]}"; do
		service=${SERVICES[$index]}
		candidate="${CONTAINER_PREFIX}_${service}_candidate_${DEPLOY_RUN_ID}"
		env_path=$(env_path_for "$service")
		port=$(port_for "$service")
		image=$(image_for "$service")
		local -a create_args=(
			create --env-file "$env_path" --env NODE_ENV=production --env HOST=0.0.0.0
			--network "$FILE_SERVER_NET"
			--publish "127.0.0.1:${port}:${port}"
			--name "$candidate" --restart always
		)
		if [[ $service == storage ]]; then
			create_args+=(--volume "$FILE_DUMP_VOLUME:$STORAGE_ASSETS_PATH")
		fi
		if [[ $service == admin-web ]]; then create_args+=(--env HOSTNAME=0.0.0.0); fi
		create_args+=("$image")
		MUTATION_STARTED=1
		CANDIDATE_CREATED[index]=1
		docker "${create_args[@]}" >/dev/null
		if service_uses_kafka "$service"; then docker network connect "$KAFKA_NET" "$candidate"; fi
	done
}

wait_until_ready() {
	local service=$1 port=$2 deadline=$3
	local url="http://127.0.0.1:${port}/health/ready"
	local now remaining request_timeout
	while :; do
		now=$(date +%s)
		remaining=$((deadline - now))
		(( remaining > 0 )) || return 1
		request_timeout=3
		(( remaining < request_timeout )) && request_timeout=$remaining
		if curl --fail --silent --show-error --connect-timeout 1 --max-time "$request_timeout" "$url" >/dev/null; then
			log "$service is ready."
			return 0
		fi
		(( $(date +%s) < deadline )) || return 1
		sleep 1
	done
}

replace_services() {
	local deadline=$(( $(date +%s) + 10#${DEPLOY_READY_TIMEOUT_SECONDS:-90} ))
	local index service canonical candidate backup port
	for index in "${!SERVICES[@]}"; do
		service=${SERVICES[$index]}
		canonical="${CONTAINER_PREFIX}_${service}"
		candidate="${canonical}_candidate_${DEPLOY_RUN_ID}"
		backup="${canonical}_backup_${DEPLOY_RUN_ID}"
		port=$(port_for "$service")
		if [[ ${OLD_EXISTS[$index]} == 1 ]]; then
			if [[ ${OLD_RUNNING[$index]} == 1 ]]; then
				OLD_STOPPED[index]=1
				docker stop "$canonical" >/dev/null
			fi
			BACKUP_CREATED[index]=1
			docker rename "$canonical" "$backup"
		fi
		NEW_CANONICAL[index]=1
		docker rename "$candidate" "$canonical"
		docker start "$canonical" >/dev/null
		wait_until_ready "$service" "$port" "$deadline" || fail "$service did not become ready before the deployment deadline"
	done
}

remove_backups() {
	local index service backup failed=0
	for index in "${!SERVICES[@]}"; do
		if [[ ${BACKUP_CREATED[$index]:-0} == 1 ]]; then
			service=${SERVICES[$index]}
			backup="${CONTAINER_PREFIX}_${service}_backup_${DEPLOY_RUN_ID}"
			if ! docker rm "$backup" >/dev/null; then
				log "ERROR: healthy deployment retained backup $backup because removal failed"
				failed=1
			fi
		fi
	done
	return "$failed"
}

main() {
	validate_inputs
	preflight_runtime
	verify_schema
	prepare_candidates
	replace_services
	DEPLOY_SUCCEEDED=1
	if ! remove_backups; then
		log 'ERROR: deployment is healthy and remains active, but backup cleanup was incomplete'
		exit 1
	fi
	trap - EXIT INT TERM
	log "Deployment completed: ${SERVICES[*]} passed /health/ready; stopped backups were removed."
}

main "$@"
