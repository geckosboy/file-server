# Stage 4 Resilience and Health Runbook

- 기준일: 2026-07-10
- 범위: cache → resize → storage 호출 복원력, cache 부하 제어, live/ready, Kafka lag/reconnect, 운영 metric
- 선행 계약: Stage 1 tenant/signed context, Stage 2 Kafka/outbox, Stage 3 PostgreSQL query/retention
- 제외: `ImageAsset`/`ImageVariant` 원장, staged upload, orphan reconciliation worker, object storage/CDN 등 Stage 5+

## 1. Health endpoint 계약

모든 HTTP 서비스는 다음 endpoint를 제공한다.

| endpoint        | 성공 응답 | 실패 응답                                  | 의미                    |
| --------------- | --------- | ------------------------------------------ | ----------------------- |
| `/health/live`  | 200 JSON  | process가 응답하지 못할 때만 실패          | process/event-loop 생존 |
| `/health/ready` | 200 JSON  | 필수 dependency가 준비되지 않으면 503 JSON | 트래픽 수신 가능 여부   |
| `/health-check` | `OK`      | readiness와 같은 503                       | 기존 probe 호환 adapter |

readiness 실패는 이미지 없음이 아니며 404로 변환하면 안 된다. caller/load balancer는 `/health/ready`의 503을 트래픽 차단 또는 명시적 degraded 상태로 처리한다.

서비스별 필수 dependency:

| 서비스                    | readiness indicator                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| cache                     | PostgreSQL `SELECT 1`, Kafka cluster metadata, resize `/health/ready`                              |
| resize                    | PostgreSQL `SELECT 1`, Kafka cluster metadata, storage `/health/ready`                             |
| storage                   | PostgreSQL `SELECT 1`, Kafka cluster metadata, local storage 임시 write/read/delete probe          |
| telemetry-api             | telemetry/lifecycle repository 연결, enabled telemetry/lifecycle Kafka consumer와 broker lag probe |
| lifecycle-consumer-tester | consumer가 enabled이면 Kafka 연결 상태; disabled이면 `ready=false`로 명시적 운영 설정 누락을 표시  |

cache/resize/storage의 Kafka probe는 다음 특성을 가진다.

- `HEALTH_PROBE_TIMEOUT_MS`를 KafkaJS `connectionTimeout`과 `requestTimeout`, upstream HTTP `AbortSignal`에 함께 적용한다. 기본값은 2000ms다.
- 성공/실패 snapshot과 같은 시점의 concurrent probe를 `HEALTH_PROBE_CACHE_TTL_MS` 동안 재사용한다. 기본값은 1000ms다.
- Kafka admin client는 probe 뒤 disconnect하며 cleanup도 같은 timeout으로 bounded 처리한다.
- upstream HTTP body는 사용하지 않더라도 cancel하여 connection/body resource를 남기지 않는다.

대표 readiness 응답:

```json
{
	"ok": true,
	"service": "cache",
	"checkedAt": "2026-07-10T08:00:00.000Z",
	"dependencies": {
		"database": { "ok": true, "latencyMs": 2 },
		"kafka": { "ok": true, "latencyMs": 4 },
		"resize": { "ok": true, "latencyMs": 3 }
	},
	"operationalMetrics": {
		"upstream": {
			"available": true,
			"requestCount": 20,
			"timeoutCount": 1,
			"transportFailureCount": 0,
			"finalStatusCounts": { "200": 18, "503": 1 }
		},
		"cache": {
			"available": true,
			"hits": 10,
			"misses": 4,
			"entries": 3,
			"bytes": 8192,
			"maxBytes": 268435456,
			"evictions": 1,
			"oversizedSkips": 0
		},
		"singleflight": {
			"available": true,
			"inFlight": 0,
			"waiters": 0,
			"coalescedRequests": 99
		}
	}
}
```

## 2. Kafka consumer readiness, lag, reconnect

telemetry/lifecycle Kafka status는 기존 `enabled`, `connected`, `consumerLag`, topic/group 필드를 유지하면서 다음 필드를 추가한다.

- `brokerConnected`, `ready`
- `partitionLag[]`: `partition`, broker high offset, group committed offset, 차이
- `lagCheckedAt`, `lastLagError`
- `reconnectAttempts`, `nextReconnectAt`
- `dlqCount`

`consumerLag`는 broker high offset에서 consumer group의 next committed offset을 뺀 partition lag의 합이다. 새 group의 offset이 `-1`이면 broker low offset을 기준으로 계산한다. offset 숫자는 응답에서 string으로 보존하고 lag 숫자는 `Number.MAX_SAFE_INTEGER`에서 포화시킨다.

최초 connect 실패는 application boot를 영구 중단하지 않는다. consumer/DLQ producer/admin probe를 정리한 뒤 background reconnect를 예약하고 readiness를 false로 유지한다. backoff는 지수 증가하지만 다음 상한을 넘지 않는다.

| telemetry 환경변수                             | lifecycle 환경변수                             | 기본값 |
| ---------------------------------------------- | ---------------------------------------------- | -----: |
| `TELEMETRY_KAFKA_CONNECT_RETRY_BACKOFF_MS`     | `LIFECYCLE_KAFKA_CONNECT_RETRY_BACKOFF_MS`     |    500 |
| `TELEMETRY_KAFKA_CONNECT_RETRY_MAX_BACKOFF_MS` | `LIFECYCLE_KAFKA_CONNECT_RETRY_MAX_BACKOFF_MS` |  10000 |
| `TELEMETRY_KAFKA_LAG_REFRESH_INTERVAL_MS`      | `LIFECYCLE_KAFKA_LAG_REFRESH_INTERVAL_MS`      |   5000 |

post-connect broker/ACL 장애로 lag refresh가 실패하면 `connected`와 별도로 `brokerConnected=false`, `ready=false`, `consumerLag=null`, `lastLagError`를 노출한다. 다음 refresh 성공 시 ready가 회복된다.

## 3. 운영 metric 의미

### 3.1 Upstream

cache와 resize readiness의 `operationalMetrics.upstream`은 `@file/nest-common`의 bounded snapshot을 그대로 사용한다. label은 `resize|storage` 고정 union이라 URL/path cardinality가 없다.

- `requestCount`
- `timeoutCount`
- `transportFailureCount`
- `finalStatusCounts[httpStatus]`

### 3.2 Cache와 singleflight

cache readiness는 실제 image request와 같은 module-scoped instance에서 다음 snapshot을 읽는다. 별도 CacheService를 만들면 실제 hit/miss/bytes를 반영하지 못하므로 금지한다.

- cache: `hits`, `misses`, `entries`, `bytes`, `maxBytes`, `evictions`, `oversizedSkips`
- singleflight: `inFlight`, `waiters`, `coalescedRequests`

`CACHE_SINGLEFLIGHT_TIMEOUT_MS`는 전체 `UPSTREAM_HTTP_TIMEOUT_MS`보다 커야 한다. 기본 5000ms 대 2000ms다. singleflight timeout이 더 작으면 origin GET이 끝나기 전에 waiter가 key를 제거하여 두 번째 origin 요청을 허용할 수 있다.

### 3.3 Telemetry, DLQ, outbox

`GET /api/admin/health`와 telemetry `/health/ready`는 다음을 반영한다.

- telemetry/lifecycle DB 연결과 metric read 가능 여부
- 두 Kafka consumer의 real lag, DLQ count, reconnect attempt
- outbox `PENDING`, `PUBLISHING`, `FAILED`, `DEAD_LETTER`, `PUBLISHED` count
- active outbox attempts 합계와 oldest unpublished age

Kafka 또는 DB가 필수인데 준비되지 않으면 top-level `ok=false`다. telemetry-api의 Kafka consumer는 명시적으로 disabled인 test/development 구성에서만 `ready=true`로 취급하되 `enabled=false`와 `disabledReason`을 노출한다. lifecycle-consumer-tester는 별도 tester 프로세스이므로 disabled 상태를 `ready=false`로 반환한다.

Stage 4에는 authoritative asset 원장과 orphan scanner가 없으므로 `reconciliation` metric은 `supported=false`, `orphanCount=null`이다. 0을 반환하여 “검사했고 orphan이 없음”으로 오해하게 만들지 않는다.

## 4. 설정 체크리스트

```dotenv
HEALTH_PROBE_TIMEOUT_MS=2000
HEALTH_PROBE_CACHE_TTL_MS=1000

UPSTREAM_HTTP_TIMEOUT_MS=2000
CACHE_SINGLEFLIGHT_TIMEOUT_MS=5000
CACHE_MAX_BYTES=268435456

TELEMETRY_KAFKA_CONNECT_RETRY_BACKOFF_MS=500
TELEMETRY_KAFKA_CONNECT_RETRY_MAX_BACKOFF_MS=10000
TELEMETRY_KAFKA_LAG_REFRESH_INTERVAL_MS=5000
LIFECYCLE_KAFKA_CONNECT_RETRY_BACKOFF_MS=500
LIFECYCLE_KAFKA_CONNECT_RETRY_MAX_BACKOFF_MS=10000
LIFECYCLE_KAFKA_LAG_REFRESH_INTERVAL_MS=5000
```

Kafka SASL/TLS, topic/group, DB, internal signed-context 설정은 [`file-server-integration-handoff.md`](file-server-integration-handoff.md)를 따른다.

## 5. 배포·rollback 순서

1. Stage 3 migration과 환경 설정을 먼저 검증한다. Stage 4에는 새 DB migration이나 신규 runtime dependency가 없다. 다만 루트 system E2E 스크립트가 workspace에서 이미 사용하던 `kafkajs` `^2.2.4`를 루트 `devDependency`로 명시했다.
2. storage → resize → cache 순서로 배포해 readiness chain이 upstream부터 성립하도록 한다.
3. telemetry-api consumer와 lifecycle tester/admin-web을 배포하고 Kafka lag/DLQ/outbox metric을 관찰한다.
4. load balancer probe를 `/health/live`와 `/health/ready`로 전환하되 `/health-check`는 호환 기간 동안 유지한다.
5. rollback 시 새 health route를 먼저 legacy probe로 되돌리고 Stage 1~3 계약을 보존한 채 서비스 이미지를 직전 버전으로 되돌린다. Stage 4 설정은 기능 플래그처럼 제거 가능하지만 signed context, tenant policy, manual offset 계약은 되돌리지 않는다.

## 6. 검증 순서와 evidence 경계

lane-local 변경은 다음으로 먼저 검증한다.

```bash
pnpm exec eslint <modified Stage 4 files>
pnpm --filter @file/cache test
pnpm --filter @file/resize test
pnpm --filter @file/storage test
pnpm --filter @file/telemetry-api test
pnpm test:component:e2e
pnpm typecheck:ts7
pnpm all:build
```

worker lane은 다른 Stage 4 lane의 commit을 포함하지 않으므로 다음 real-infrastructure gate는 **모든 Stage 4 task가 통합된 final HEAD**에서 실행한다.

```bash
pnpm test:system:e2e
pnpm test:kafka:acl:e2e
pnpm docker:build
pnpm test:docker:smoke
```

최종 fault-injection evidence에는 최소 다음을 기록한다.

1. DB 중단 중 `/health/live` 200, `/health/ready` 503, telemetry top-level `ok=false`.
2. 최초 Kafka connect 실패 뒤 `reconnectAttempts/nextReconnectAt` 노출, broker 복구 뒤 `ready=true`와 real lag.
3. resize/storage readiness 503이 cache/resize readiness 503으로 전파되고 이미지 404로 바뀌지 않음.
4. 100개 동일 cache miss에서 origin resize 1회, waiter/`coalescedRequests` metric 증가.
5. byte budget 초과 시 eviction/oversized metric과 bounded RSS.
6. poison message DLQ count 증가 후 다음 정상 offset 처리.
7. outbox retry/dead-letter/oldest-age metric이 실제 PostgreSQL 상태와 일치.
8. 모든 Docker/ACL test 종료 후 임시 container/network/volume cleanup.

## 7. Final integrated gate evidence (2026-07-10)

Verified on stable clean HEAD `ef071601e384a532276fa7e37f3a3f6ba36ffd9a`:

| Gate                     | Result | Duration |
| ------------------------ | ------ | -------: |
| `pnpm test:system:e2e`   | PASS   |      93s |
| `pnpm docker:build`      | PASS   |     293s |
| `pnpm test:docker:smoke` | PASS   |      38s |

Cleanup passed for task-owned resources (`fs-system-e2e-38529`, `fs-docker-smoke-98050`): no containers, networks, volumes, or matching processes remained. A concurrent `travel-cloud-phase0` resource was explicitly attributed as unrelated and was not modified. Evidence logs are under `/tmp/stage4-task20-ef071601e384-20260710T095524Z/`. Remaining risk: the final gate validates the integrated snapshot; future changes must rerun these commands on the resulting clean HEAD.
