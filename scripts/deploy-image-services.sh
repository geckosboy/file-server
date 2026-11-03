#!/usr/bin/env bash
set -Eeuo pipefail

readonly SERVICES=(storage resize cache)
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

log() { printf '[deploy] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

required_value() {
	local name=$1
	[[ -n ${!name:-} ]] || fail "$name is required"
}

image_for() {
	case $1 in
		storage) printf '%s' "$STORAGE_IMAGE" ;;
		resize) printf '%s' "$RESIZE_IMAGE" ;;
		cache) printf '%s' "$CACHE_IMAGE" ;;
	esac
}

env_path_for() {
	case $1 in
		storage) printf '%s' "$STORAGE_ENV_PATH" ;;
		resize) printf '%s' "$RESIZE_ENV_PATH" ;;
		cache) printf '%s' "$CACHE_ENV_PATH" ;;
	esac
}

port_for() {
	case $1 in
		storage) printf '%s' "$STORAGE_PORT" ;;
		resize) printf '%s' "$RESIZE_PORT" ;;
		cache) printf '%s' "$CACHE_PORT" ;;
	esac
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
	local name service image env_path port
	for name in STORAGE_IMAGE RESIZE_IMAGE CACHE_IMAGE STORAGE_ENV_PATH RESIZE_ENV_PATH CACHE_ENV_PATH STORAGE_PORT RESIZE_PORT CACHE_PORT FILE_SERVER_NET KAFKA_NET FILE_DUMP_VOLUME DEPLOY_RUN_ID; do
		required_value "$name"
	done
	[[ $DEPLOY_RUN_ID =~ ^[0-9]+(-[0-9]+)*$ ]] || fail 'DEPLOY_RUN_ID must contain numeric components separated by hyphens'
	[[ $FILE_DUMP_VOLUME == file_dump_volume ]] || fail 'FILE_DUMP_VOLUME must be file_dump_volume'
	[[ $FILE_SERVER_NET != "$KAFKA_NET" ]] || fail 'FILE_SERVER_NET and KAFKA_NET must be different networks'
	for service in "${SERVICES[@]}"; do
		image=$(image_for "$service")
		env_path=$(env_path_for "$service")
		port=$(port_for "$service")
		[[ $image =~ ^ghcr\.io/[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || fail "$service image must be an immutable ghcr.io digest"
		[[ -f $env_path && -r $env_path ]] || fail "$service env path must be a readable file"
		grep -Eq '^[[:space:]]*DATABASE_URL=' "$env_path" || fail "$service env path must define DATABASE_URL"
		if ! [[ $port =~ ^[0-9]+$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
			fail "$service port must be between 1 and 65535"
		fi
	done
	[[ $STORAGE_PORT != "$RESIZE_PORT" && $STORAGE_PORT != "$CACHE_PORT" && $RESIZE_PORT != "$CACHE_PORT" ]] || fail 'service ports must be unique'
	[[ ${DEPLOY_READY_TIMEOUT_SECONDS:-90} =~ ^[0-9]+$ ]] || fail 'DEPLOY_READY_TIMEOUT_SECONDS must be numeric'
	(( 10#${DEPLOY_READY_TIMEOUT_SECONDS:-90} >= 1 && 10#${DEPLOY_READY_TIMEOUT_SECONDS:-90} <= 90 )) || fail 'DEPLOY_READY_TIMEOUT_SECONDS must be between 1 and 90'
	command -v docker >/dev/null || fail 'docker is required'
	command -v curl >/dev/null || fail 'curl is required'
	[[ -r $SCHEMA_SCRIPT_PATH ]] || fail 'schema verification script is not readable'
}

preflight_runtime() {
	docker network inspect "$FILE_SERVER_NET" >/dev/null || fail "FILE_SERVER_NET does not exist"
	docker network inspect "$KAFKA_NET" >/dev/null || fail "KAFKA_NET does not exist"
	docker volume inspect "$FILE_DUMP_VOLUME" >/dev/null || fail 'required storage volume does not exist; refusing an empty-data deployment'

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
	local expected_migrations
	expected_migrations=$(find "$REPOSITORY_ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort | paste -sd, -)
	[[ -n $expected_migrations ]] || fail 'no checked-out Prisma migrations were found'
	log 'Verifying applied migrations and online backfill indexes (read-only).'
	docker run --rm \
		--network "$FILE_SERVER_NET" \
		--env-file "$STORAGE_ENV_PATH" \
		--env "EXPECTED_MIGRATIONS=$expected_migrations" \
		--volume "$SCHEMA_SCRIPT_PATH:/usr/index/apps/storage/verify-deployment-schema.cjs:ro" \
		"$STORAGE_IMAGE" \
		node /usr/index/apps/storage/verify-deployment-schema.cjs
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
			create --env-file "$env_path" --env HOST=0.0.0.0
			--network "$FILE_SERVER_NET"
			--publish "127.0.0.1:${port}:${port}"
			--name "$candidate" --restart always
		)
		if [[ $service == storage ]]; then
			create_args+=(--volume "$FILE_DUMP_VOLUME:$STORAGE_ASSETS_PATH")
		fi
		create_args+=("$image")
		MUTATION_STARTED=1
		CANDIDATE_CREATED[index]=1
		docker "${create_args[@]}" >/dev/null
		docker network connect "$KAFKA_NET" "$candidate"
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
	log 'Deployment completed: storage, resize, and cache passed /health/ready; stopped backups were removed.'
}

main "$@"
