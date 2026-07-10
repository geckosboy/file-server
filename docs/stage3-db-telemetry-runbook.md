# Stage 3 DB Telemetry Retention and Verification Runbook

- 범위: 아키텍처 개선 계획의 단계 3만 다룬다.
- 기준일: 2026-07-10
- 안전 기본값: retention scheduler는 모든 환경에서 비활성이다.
- 제외: 단계 4 timeout/health/singleflight와 단계 5 asset lifecycle.

## 1. 운영 활성화 게이트

`DATA_RETENTION_ENABLED=true`는 자동 적용 값이 아니다. production data owner와 security/compliance owner가 다음을 승인한 뒤에만 설정한다.

1. telemetry 90일이 조사·장애 분석 요구를 충족하는지 확인한다.
2. lifecycle와 admin audit의 법적·업무 보존 기간을 각각 확정한다.
3. `000009_stage3_db_telemetry_indexes`를 적용하고 retention query의 `EXPLAIN (ANALYZE, BUFFERS)`를 검토한다.
4. 만료 예상 row 수, batch 수, 실행 창, lock timeout을 승인한다.
5. 1M-row 성능 fixture/benchmark에서는 `DATA_RETENTION_ENABLED=false`를 유지한다.

승인 전 권장값:

```dotenv
DATA_RETENTION_ENABLED=false
TELEMETRY_RETENTION_DAYS=90
LIFECYCLE_EVENT_RETENTION_DAYS=0
ADMIN_AUDIT_RETENTION_DAYS=0
```

`0`은 lifecycle 또는 audit target만 비활성화한다. telemetry 보존 기간은 1일 이상이어야 하며 scheduler 자체는 명시적 enable gate가 없으면 실행되지 않는다. `NODE_ENV=test`에서는 interval도 자동으로 0이다.

## 2. 설정 계약

| 환경변수                             |   기본값 | 계약                                                        |
| ------------------------------------ | -------: | ----------------------------------------------------------- |
| `DATA_RETENTION_ENABLED`             |  `false` | `true`일 때만 scheduler 시작                                |
| `DATA_RETENTION_INTERVAL_MS`         | 86400000 | 실행 간격, `0`이면 scheduler 비활성                         |
| `TELEMETRY_RETENTION_DAYS`           |       90 | `occurred_at < cutoff` telemetry 삭제                       |
| `LIFECYCLE_EVENT_RETENTION_DAYS`     |        0 | owner 승인 전 비활성; `occurred_at < cutoff` lifecycle 삭제 |
| `ADMIN_AUDIT_RETENTION_DAYS`         |        0 | compliance 승인 전 비활성; `created_at < cutoff` audit 삭제 |
| `DATA_RETENTION_BATCH_SIZE`          |      250 | transaction 한 번의 최대 row 수                             |
| `DATA_RETENTION_MAX_BATCHES_PER_RUN` |       20 | target 한 개의 실행당 최대 batch 수                         |
| `DATA_RETENTION_BATCH_SLEEP_MS`      |      100 | full batch 사이의 휴지 시간                                 |
| `DATA_RETENTION_LOCK_TIMEOUT_MS`     |     1000 | transaction-local PostgreSQL `lock_timeout`                 |

잘못된 boolean, 음수, 소수, 0일 telemetry, 과도한 batch/timeout은 fallback하지 않고 시작 시 거부한다. 실제 예시는 [`apps/telemetry-api/.env.local.example`](../apps/telemetry-api/.env.local.example)에 있다.

## 3. 삭제 경계와 동시성

`DatabaseRetentionService.runRetentionCycle(now)`는 telemetry, lifecycle, admin audit를 순서대로 처리한다. target별 동작은 다음과 같다.

1. 정적 table/column SQL과 parameterized cutoff/limit을 사용한다.
2. transaction 안에서 `set_config('lock_timeout', ..., true)`를 설정한다.
3. 오래된 ID를 시간/ID 오름차순으로 `FOR UPDATE SKIP LOCKED LIMIT batchSize` 조회한다.
4. 같은 transaction에서 조회된 ID만 삭제한다.
5. full batch 뒤에는 sleep하고 `maxBatchesPerRun`에서 반드시 멈춘다.
6. process-local 중복 실행은 skip하며 replica 간에는 row lock이 중복 삭제 작업을 피한다.

cutoff는 strict `<`다. cutoff와 정확히 같은 row와 최근 row는 남는다. telemetry/lifecycle은 event가 늦게 도착해도 canonical `occurredAt` 기준으로 보존 기간을 계산한다. replay된 오래된 event를 수신 시점부터 다시 90일 보존해야 한다면 enable 전에 별도 업무 결정을 내려야 한다.

결정적 검증 entrypoint:

- `runRetentionCycle(now)` / `runOnce(now)`: scheduler와 같은 전체 cycle
- `drainBatch(target, cutoff)`: 한 target의 transaction 한 번

## 4. lifecycle outbox 보존

Stage 2 terminal 상태 계약을 유지한다.

- `PUBLISHED`: 기본 30일 뒤 cleanup 가능
- `DEAD_LETTER`: 발행 재시도가 끝난 terminal row이며 기본 90일 뒤 cleanup 가능
- `PENDING`, `PUBLISHING`, `FAILED`: 미발행/재시도 대상이므로 cleanup 금지

cleanup은 `LIFECYCLE_OUTBOX_CLEANUP_BATCH_SIZE`, `...MAX_BATCHES_PER_RUN`, `...BATCH_SLEEP_MS`, `...LOCK_TIMEOUT_MS`를 사용한다. select뿐 아니라 delete predicate에서도 terminal status와 cutoff를 다시 확인한다. `(eventId, topic)` destination 중 하나가 아직 `FAILED`이면 다른 terminal destination과 같은 ID 후보 목록에 포함되어도 delete predicate가 실패 row를 보존한다.

published outbox 삭제 뒤 producer 측 destination dedupe history는 사라진다. 장기 replay 중복은 consumer가 업무 DB의 durable `eventId` unique/idempotency로 막아야 한다.

## 5. 활성화 순서

1. `DATA_RETENTION_ENABLED=false`로 새 버전을 배포한다.
2. migration을 적용하고 실제 production-like 통계로 `ANALYZE`를 실행한다.
3. 다음 read-only count로 삭제 예상량을 기록한다.

```sql
SELECT count(*) FROM telemetry_events
WHERE occurred_at < now() - interval '90 days';

SELECT count(*) FROM image_lifecycle_events
WHERE occurred_at < now() - make_interval(days => :approved_lifecycle_days);

SELECT count(*) FROM admin_audit_logs
WHERE created_at < now() - make_interval(days => :approved_audit_days);
```

4. 승인된 lifecycle/audit 기간과 batch 설정을 주입한다.
5. canary 한 개에서 `runRetentionCycle`의 실제 PostgreSQL 검증을 수행하고 두 번째 실행이 0건인지 확인한다.
6. lock wait, query time, 삭제량, ingestion lag를 확인한 뒤 `DATA_RETENTION_ENABLED=true`로 scheduler를 켠다.
7. `event=database_retention_completed|database_retention_failed`와 storage의 `image_lifecycle_outbox_background_task_failed`를 경보/로그 검색에 연결한다.

문제가 생기면 `DATA_RETENTION_ENABLED=false`와 outbox `LIFECYCLE_OUTBOX_CLEANUP_INTERVAL_MS=0`으로 다음 실행을 막는다. 이미 삭제된 데이터 복원은 backup/PITR 절차를 사용한다.

## 6. 검증 매트릭스

| 계층                 | 명령/entrypoint                                                                                                                                                                                              | PASS 근거                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| retention unit       | `pnpm --filter @file/telemetry-api test -- database-retention --runInBand`                                                                                                                                   | enable gate, 별도 기간, bounded batch, cutoff, lock, idempotent rerun, overlap skip                                     |
| outbox regression    | `pnpm --filter @file/storage test -- image-lifecycle-outbox.service.spec.ts --runInBand`                                                                                                                     | active status 보존, terminal predicate 재검증, multi-batch, lock timeout/retry                                          |
| telemetry memory E2E | `pnpm --filter @file/telemetry-api test:e2e -- --runInBand`                                                                                                                                                  | `NODE_ENV=test`/memory mode가 `DATABASE_URL` 없이 시작                                                                  |
| schema               | `pnpm db:generate && pnpm exec prisma validate`                                                                                                                                                              | Prisma client/migration schema 유효                                                                                     |
| static               | `pnpm --filter @file/telemetry-api lint && pnpm --filter @file/storage lint && pnpm typecheck:ts7`                                                                                                           | 수정 파일 lint/typecheck                                                                                                |
| build/regression     | `pnpm all:test && pnpm test:component:e2e && pnpm all:build`                                                                                                                                                 | 단계 1/2 계약 회귀 없음                                                                                                 |
| PostgreSQL retention | `RETENTION_POSTGRES_TEST=true DATABASE_URL=... pnpm --filter @file/telemetry-api test -- database-retention.postgres --runInBand`                                                                            | old만 삭제, exact/recent 보존, 두 번째 0건, concurrent worker의 disjoint bounded batch                                  |
| 1M performance       | `STAGE3_BENCHMARK_DATABASE_URL=<disposable-url> node --expose-gc scripts/stage3-db-telemetry-benchmark.mjs --rows=1000000 --samples=20 --warmups=5 --output=artifacts/stage3-db-telemetry/benchmark-1m.json` | first/mid cursor bounded rows, before/after EXPLAIN, list p95 ≤ 300ms, 24h aggregate p95 ≤ 1s, request RSS 증가 ≤ 100MB |
| system               | `pnpm test:system:e2e`                                                                                                                                                                                       | 실제 PostgreSQL/Kafka outage/redelivery와 Stage 2 outbox 계약 유지                                                      |

최종 integration evidence에는 PostgreSQL/Node 버전, 1M seed 방식, warmup/sample 수, p95/RSS, query plan artifact path, retention 승인자와 실제 적용값을 함께 남긴다. Docker나 production-like PostgreSQL을 실행할 수 없는 환경은 unit 결과로 대체하지 말고 verification gap으로 기록한다.

### 기록된 Stage 3 DB evidence

- worker-2 lane commit: `1860da7`
- migration: `000009_stage3_db_telemetry_indexes`; PostgreSQL `18.4` deploy PASS
- indexes: telemetry/lifecycle `(occurred_at,id)`와 `admin_audit_logs(created_at,id)`
- benchmark artifact: `artifacts/stage3-db-telemetry/benchmark-1m.json`
- benchmark runtime: Node `22.15.0`, PostgreSQL `18.4`, 1,000,000 deterministic rows, warmup 5, samples 20
- final application-Prisma PASS: first page p95 `4.18ms`, middle cursor page p95 `171.95ms`, dashboard 24h p95 `67.15ms`, maximum request RSS delta `110,592 bytes`; each list query materialized the bounded `51` rows (`take + 1`)
- supplemental direct-SQL evidence: first/middle/dashboard p95 `3.43ms`/`2.59ms`/`67.02ms`; this is EXPLAIN comparison evidence, not the application-path acceptance result
- compiled application probe commit/artifact: `e9ef7a6`, `artifacts/stage3-db-telemetry/app-probe-1m.json`
- compiled `PrismaAdminAnalyticsRepository` PASS: summary p95 `122.37ms`, timeseries p95 `168.99ms`, top images p95 `90.83ms`; all RSS/performance gates true
