# File Server 필수 범위 완료 감사

- 감사일: 2026-11-02
- 코드 기준: `feat/admin`의 `7bb6482` 기반 감사 수정. 검증은 커밋 전 통합 worktree에서 실행했으며 시작 시 worktree는 clean이었다.
- 범위: 아키텍처 개선 계획 단계 0~5. **선택 단계 6 및 TypeScript 7 제외.**
- 판단: **핵심 구현과 과거 통합 PASS 기록은 있으나, 최신 release 전체 완료는 아직 선언할 수 없다.** 이 감사에서 확인한 코드/CI 불일치를 수정하고, 실행이 차단된 검증과 실제 배포 결정을 남겼다.
- 시각화: [architecture.html의 완료 감사](architecture.html#completion-audit)

## 1. 기준별 대조

| 필수 범위          | 구현 및 테스트 근거                                                                                                                                                                                           | 감사 판단                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 배포/회귀 기반     | `.github/workflows/{ci,deploy}.yml`, `docker/apps/Dockerfile.*`, `scripts/{system-e2e,docker-smoke}.mjs`                                                                                                      | Node 22/pnpm 및 기본 gate 존재. 빠진 lifecycle/ACL gate와 script regression/current TypeScript 검증을 추가하고 배포 upstream 순서를 수정. 실제 운영 network 경계는 미확정                       |
| 테넌트/제어면 보안 | `libs/database/src/client-service-authorization.ts`, `client-service-auth.ts`, 각 앱 guard, `libs/image-contracts/src/path-security.ts`, `libs/database/src/test/client-service-{auth,authorization}.spec.ts` | 정책∩scope, tenant namespace, signed context, upload path-before-file, revoke 재검증의 구현/테스트 존재. 이번 bounded review에서 새 auth 우회 근거는 발견하지 못함 (보안 무결점 보장은 아님)    |
| 이벤트 전달/격리   | `libs/telemetry-contracts/src`, `apps/telemetry-api/src/modules/kafka`, storage lifecycle outbox, `scripts/kafka/test/kafka-acl-isolation.e2e.sh`                                                             | manual commit, bounded retry/DLQ, destination별 outbox 및 tenant ACL 테스트 존재. 활성 consumer의 broker 누락이 ready=true가 되는 결함 수정                                                     |
| DB 조회/retention  | `apps/telemetry-api/src/modules/{telemetry,lifecycle,admin,retention}`, `prisma-admin-analytics.repository.ts` 및 repository/cursor/retention tests                                                           | query object, opaque cursor, bounded take, SQL aggregation/retention 구현. 1M 성능·EXPLAIN은 보존된 과거 artifact 근거이며 이번 재측정 아님                                                     |
| HTTP/cache/health  | `libs/nest-common/src/http/upstream-fetch.ts`, cache image/cache service 및 테스트, 각 앱 health, Kafka status/lag/reconnect tests                                                                            | timeout/status/GET retry, 100 miss singleflight, byte budget, live/ready 테스트 존재. Kafka 설정 fail-open 수정. HTTP E2E는 이번 권한 제한으로 차단                                             |
| 자산 수명주기      | migrations `000010`/`000011`, `libs/database/src/image-asset-metadata.repository.ts`, storage image lifecycle/filesystem/variant worker, `scripts/image-lifecycle-system-e2e.mjs`                             | staged upload/상태 전이/outbox/backfill/lease/reconciliation/delete/variant fencing 구현·테스트 존재. scheduler cadence 수정. delete 전역 동기 무효화와 arbitrary-scale 5분 SLA는 보장하지 않음 |

원래 계획은 `.omx/plans/file-server-architecture-remediation.md`에 있으며, `.omx/`는 git-ignored이다. 이번에 그 로컬 문서도 상태/검증 범위를 보정했지만 **다른 checkout/프로젝트는 이 tracked 감사 문서와 handoff를 함께 기준으로 삼아야 한다.**

## 2. 확인·수정한 사항

### Reconciliation cadence

- 실행 주기로 읽던 `intervalMs` 대신 `batchSleepMs`를 쓰던 오류를 수정했다.
- 이제 `IMAGE_RECONCILIATION_INTERVAL_MS` → 미설정 시 폐기 예정 `IMAGE_RECONCILIATION_BATCH_SLEEP_MS` → 기본 60초 순으로 결정한다.
- 중복 config 필드를 제거했다. `BATCH_SLEEP`은 실제 batch 내부 sleep이 아니라 **이전 cadence 설정의 호환 별칭**이다.
- 서로 다른 두 설정의 우선순위, legacy-only, 중복 실행 억제, 오류 뒤 재시도, 종료 timer 정리를 regression-first로 검증했다.
- 기본 stale 4분 + cadence 1분은 소규모 fixture 목표다. 한 tick의 batch/scan 상한, 오래 걸리는 실행, urgent backlog와 전체 inventory 때문에 임의 규모의 hard 5분 복구 SLA를 충족했다고 주장하지 않는다. metadata 없는 파일은 기본 보고만 하고 owner 승인 flag 이전에는 삭제하지 않는다.

### Kafka 설정 fail-closed

- telemetry/lifecycle consumer가 활성 상태여야 하는데 broker가 없으면 `enabled=false, ready=true`로 내려가던 동작을 제거했다.
- 활성 consumer의 전용/공통 broker가 모두 누락되면 bootstrap에서 명시적으로 실패한다. 프로세스가 정상 ready인 것처럼 계속 뜨지 않는다.
- 전용 broker의 공백은 공통 broker fallback으로 처리한다. 명시적 consumer 비활성 및 test 기본 비활성 호환은 유지한다.
- 양쪽 config와 bootstrap/factory 호출 여부를 regression-first로 검증했다.

### CI/배포 검증 지속성

- `image-lifecycle-e2e`, `kafka-acl-e2e`를 quality 다음 별도 job으로 추가했다. run ID/attempt별 project, timeout, job 범위의 `always()` cleanup을 둔다.
- 기존 TS7 필수 CI gate를 로컬 lockfile TypeScript를 쓰는 `pnpm all:typecheck`로 대체했다. 먼저 `next typegen`으로 route 검증 타입을 생성하므로 clean checkout에서도 페이지 export 계약을 검사한다. 기존 optional TS7 script는 삭제하지 않았고 **실행하지 않았다**.
- `pnpm test:scripts`와 CI/deploy 구조 regression을 추가했다. 이 test는 구조 검증이지 GitHub runner에서 job을 실제 실행했다는 증거는 아니다.
- 서로 의존하는 배포를 storage → resize → cache readiness 순서로 직렬화했다. 이 수정은 무중단 candidate/switch 배포를 구현하는 것은 아니다.

### Admin route의 실제 빌드 오류

- 일반 타입검사가 처음 통과한 뒤 Next 생성 타입이 있는 상태와 보조 `next build --webpack`에서 재검증하자 6개 `page.tsx`의 추가 named `*PageContent` export가 Next route 계약에 어긋나 실제 실패했다. 이를 단순 sandbox 문제로 분류하지 않았다.
- UI content/타입/helper를 adjacent `page-content.tsx`로 분리하고 async route의 fetch orchestration 및 default export를 유지했다. 기존 렌더링/오류·fixture UI 동작을 변경하지 않고 테스트 import만 옮겼다.
- generated `.next/types`를 지우거나 typecheck에서 admin을 빼는 우회는 하지 않았다. 여섯 route의 export 계약을 새 회귀 테스트로 고정했다.

## 3. 변경하지 않고 명확히 기록한 계약 차이

### Delete 성공의 의미

이미 다른 프로젝트에 공개한 비동기 계약을 유지한다.

1. HTTP 200 전: known 원본/variant 파일 정리 및 `Deleted` metadata + lifecycle/cache-invalidation outbox transaction 완료.
2. HTTP 200 후: Kafka 발행, 모든 process-local cache replica 무효화, 늦은 worker output의 reconciliation 수렴.

원계획의 “HTTP 성공 즉시 모든 replica cache가 비어 있음”은 문자 그대로 충족하지 않는다. 이를 완료로 둔갑시키지 않고 원계획에 차이를 명시했다. 현재 consumer의 invalidation fencing은 **이벤트 도착 이후**의 in-flight stale cache 재적재를 막는 장치이지, 전역 동기 삭제 보장이 아니다. 단순 invalidation이 오지 않은 replica는 기존 캐시를 반환할 수 있으므로 outbox 상태·consumer 연결/lag·DLQ 및 cache TTL을 운영에서 관측해야 한다.

### 운영 network 경계

Travel 통합 Compose의 Nginx-only 공개 구조와 production workflow는 같지 않다. 현재 `.github/workflows/deploy.yml`은 storage/resize/cache host port를 모든 인터페이스에 publish한다. 특히 resize/storage GET은 내부 전용이므로 실제 Nginx 위치, Docker network, host firewall과 외부 도달성을 검증하고 publish 제거/loopback bind/방화벽을 결정하기 전에는 외부 비노출을 보장하지 않는다. 환경을 모른 채 기존 ingress를 깨는 변경이나 운영 배포는 하지 않았다.

## 4. 이번 실행 증거

환경: macOS x64, Node `22.23.1`, pnpm `10.15.0`, 저장소 TypeScript `5.9.3`, Prisma `7.8.0`. 로그: `.tmp/completion-audit/` (git-ignored, 비밀 env 값은 출력하지 않음).

과거 PASS와 아래 결과는 합산하지 않는다. HTTP port를 열지 않는 unit 실행에서는 `--watchman=false --runInBand`를 사용했다. Watchman이 sandbox 바깥 LaunchAgents에 쓰려던 최초 실패는 이 옵션으로 해소했으며 보안 제한을 우회하지 않았다.

| 검증                                                               | 이번 결과 및 범위                                                                                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma generate / validate                                         | PASS. DB migration 실행을 뜻하지 않음                                                                                                                                                                    |
| 전체 lint                                                          | 11/11 workspace PASS; admin 분리 후 scoped lint도 PASS                                                                                                                                                   |
| unit, HTTP health 제외                                             | 최종 통합 수정에서 **533 PASS / PostgreSQL 전용 3 skipped**, 11/11 workspace. `health.e2e.spec.ts`의 HTTP 5건은 sandbox 제한으로 제외. 이 결과를 무조건 전체 unit PASS로 표시하지 않음                   |
| script regression                                                  | 13/13 PASS. workflow 구조/배포 순서와 기존 benchmark/helper 검사                                                                                                                                         |
| 백엔드·라이브러리 build                                            | 10/10 PASS (`pnpm turbo run build --force --filter='!@file/admin-web'`)                                                                                                                                  |
| 전체 unit 기본 명령                                                | HTTP health 5건에서 `listen EPERM: 0.0.0.0`; 전체 PASS 아님                                                                                                                                              |
| component E2E                                                      | 네 앱 모두 시도했으나 HTTP `listen EPERM`; assertion 환경 미충족으로 차단                                                                                                                                |
| 일반 system E2E                                                    | `getFreePort()`의 `listen EPERM: 127.0.0.1`에서 차단; 인프라 시작 전 종료                                                                                                                                |
| 기본 전체 build                                                    | admin Turbopack의 PostCSS IPC port bind `Operation not permitted`; 기본 전체 PASS 아님                                                                                                                   |
| 현재 TypeScript / admin 보조 build                                 | 페이지 분리 후 `pnpm all:typecheck` PASS (Next typegen 및 `.next/types` 포함). `pnpm --filter @file/admin-web exec next build --webpack` PASS, 9/9 route 생성. 기본 Turbopack build 통과로 대체하지 않음 |
| admin 회귀 테스트                                                  | 10 suites / 61 tests PASS (기존 55 + route 경계 6). UI/data/auth 동작 보존                                                                                                                               |
| Kafka topic bootstrap shell test                                   | `scripts/kafka/test/ensure-image-topics.test.sh` PASS. mock command 기반이며 실제 broker ACL 검증은 아님                                                                                                 |
| Docker build/smoke, lifecycle system, Kafka ACL, 실제 PG/1M 재측정 | prerequisite `docker info`가 Docker socket permission denied. 실패가 확인된 선행 권한을 우회하지 않고 dependent checks는 재실행하지 않음                                                                 |
| 문서·스크립트 정적 검사                                            | Prettier YAML/HTML/Markdown parsing, HTML unique ID/audit link, node syntax, diff whitespace 검사 PASS. 브라우저 Mermaid 재렌더는 하지 않음 (다이어그램 코드 불변)                                       |

실행 명령 (저장소 root, 값 대입 없이 재현 가능):

```bash
pnpm db:generate
pnpm exec prisma validate
pnpm all:lint --force
pnpm all:typecheck
pnpm all:test --force --continue -- --watchman=false --runInBand --testPathIgnorePatterns=health.e2e.spec.ts
pnpm test:scripts
scripts/kafka/test/ensure-image-topics.test.sh
pnpm turbo run build --force --filter='!@file/admin-web'
pnpm --filter @file/admin-web exec next build --webpack
```

Docker·HTTP 권한이 있는 환경에서는 제외 옵션 없는 `pnpm all:test`, `pnpm test:component:e2e`, `pnpm test:system:e2e`, `pnpm test:image-lifecycle:system:e2e`, `pnpm test:kafka:acl:e2e`, `pnpm all:build`, `pnpm docker:build`, `pnpm test:docker:smoke`가 추가 필수다. 이번 권한 제한을 코드 우회나 성공 exit code로 감추지 않았다. 이번 감사의 system test는 인프라 시작 전 실패했으므로 신규 컨테이너/network/volume을 만들지 않았다. host process 전체 조회도 sandbox에서 차단되어 외부 리소스 전체 cleanup을 검증했다는 주장은 하지 않는다.

## 5. 과거 증거 (이번 재실행 아님)

- 단계별 핵심 커밋: `b39e1ac` → `e1f9049` → `96792ac` → `bfff2e3` → `9708eb0` → `a40514a`.
- `a40514a` Tested에는 unit/lint/build/component/lifecycle system/Kafka ACL/Docker smoke 등이 기록돼 있다. 이번 감사는 commit trailer를 새로운 실행 증거로 사용하지 않는다.
- `docs/image-asset-lifecycle-runbook.md`의 2026-07-11 기록: 11 migration, backfill 멱등/cutover audit, 7 crash boundary, reconciliation 9,420ms, 늦은 Deleted variant cleanup 102ms. migration/backfill의 실제 운영 DB 적용 결과가 아니다.
- `artifacts/stage3-db-telemetry/{benchmark-1m,app-probe-1m}.json`: 1M fixture, before/after EXPLAIN 및 성능 gate 기록. 측정 환경·명령은 `docs/stage3-db-telemetry-runbook.md` 참조.

## 6. 필수 범위에서 남은 release gate

독립 최종 코드리뷰는 35개 파일을 검토해 이번 수정 diff를 **APPROVE**했다. 신규 Critical/High는 없으며, 기존 production host port 공개 1건을 Medium/pre-release prerequisite로 남겼다. 이는 아래 운영·실인프라 gate까지 완료됐다는 승인은 아니다.

- Docker와 localhost listen이 허용된 환경에서 최신 통합 diff/revision의 전체 unit(HTTP health 포함), component E2E, 일반/lifecycle system E2E, Kafka ACL, 기본 전체 build, Docker build/smoke를 새로 통과시킨다. CI 수정 자체만으로 실행 PASS를 선언하지 않는다.
- 운영 ingress에서 내부 resize와 storage GET의 network 비노출을 확인/설정하고 기존 컨테이너 교체 방식의 장애 창을 배포 리허설에서 확인한다.
- 실제 운영 DB/파일에 migration → backup/PITR 확인 → backfill → outbox/Kafka ingestion drain → cutover audit zero gap → write/read switch 순서를 적용한다. `snapshotComplete=true`만으로 cutover 완료라고 하지 않는다.
- 목표 inventory/urgent backlog에서 batch/scan/interval이 요구하는 reconciliation 복구 목표를 충족하는지 측정한다. 모든 크기에 대한 5분 hard SLA는 미증명이다.

선택 단계 6은 위 잔여 작업에 포함하지 않는다. 신규 object storage/CDN/Redis/분산 lock이나 운영 credential/배포 변경은 수행하지 않았다.
