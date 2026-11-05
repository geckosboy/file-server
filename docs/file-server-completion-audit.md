# File Server 필수 범위 완료 감사

- 감사 기간: 2026-11-02~2026-11-03
- 기준: `7bb6482`에서 시작, 1차 감사 커밋 `844a733` 후 추가 수정·실인프라 검증
- 범위: **단계 0~5**. 선택 단계 6과 TypeScript 7은 제외한다.
- 검증 환경: macOS x64 / Node `22.23.1` / pnpm `10.15.0` / TypeScript `5.9.3` / Prisma `7.8.0` / disposable PostgreSQL `18.6` / Kafka `4.3.1` / 실제 Docker·Nginx
- 실행 경계: 로컬 격리 인프라에서 검증했다. 실제 운영 서버 배포, 운영 DB migration/backfill/cutover, 원격 GitHub Actions 실행 및 push는 수행하지 않았다.

## 1. 최종 판단과 증거

단계 0~5의 핵심 구현과 정합성 수정을 완료했고, 아래 실제 실행 증거를 확보했다. 최초 sandbox 실패를 미해결 사유로 남기지 않고 승인된 실행 경로로 Docker/HTTP 검증을 재수행했다. 코드 존재, 과거 커밋의 Tested 문구, 실제 운영 반영은 서로 구분한다.

| Gate                      | 이번 실제 결과                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 단위 테스트               | **545 PASS**, HTTP health 포함. PostgreSQL 전용 3건은 이 명령에서 skip되며 아래 실제 PG gate에서 **3/3 PASS**                                                  |
| Script regression         | **18/18 PASS**                                                                                                                                                 |
| 전체 lint                 | **11/11 workspace PASS**                                                                                                                                       |
| 현재 TypeScript           | **5.9.3 PASS**, Next route typegen 및 생성 타입 포함                                                                                                           |
| 기본 전체 build           | **11/11 PASS**, admin 기본 Turbopack 포함                                                                                                                      |
| HTTP component E2E        | **38/38 PASS, 최종 2회 연속 통과** — 테스트 서버를 명시적으로 listen/close해 per-request 서버 수명의 불안정을 제거했다                                         |
| 실제 일반 system E2E      | **PASS** — tenant 403, replica 공통 rate limit 429, cache→resize→storage, Kafka/PG 장애·복구, poison DLQ, offset/outbox 재전달                                 |
| 실제 lifecycle system E2E | **PASS** — 11 migrations/index, 멱등 backfill/cutover audit, 7 crash 경계, variant retry/duplicate/poison, 두 cache replica, delete race와 capacity 전체 phase |
| Kafka ACL E2E             | **PASS** — 자기 topic/group 허용, 다른 client/canonical/worker topic 및 쓰기 거부                                                                              |
| Docker build / smoke      | 최종 세 이미지 build 및 **smoke PASS** — Node 지원 버전, non-root, runtime secret/env 경계와 dependency readiness                                              |
| 배포 boundary 리허설      | **PASS** — Docker create/inspect에서 loopback publish와 두 network 연결, exact-resource cleanup                                                                |
| 실제 Nginx 통합           | **PASS** — Travel Client Service/key/policy/subscription/SCRAM 발급, PROVISIONED, 실제 upload/read/delete·멱등 retry·lifecycle·ACL·404 수렴                    |
| 실제 PG 조회/retention    | **3/3 PASS**, migration·retention 경계 및 반복 실행 검증                                                                                                       |
| 1M 성능/실제 SQL plan     | **모든 gate PASS**, 아래 측정값과 artifact 참조                                                                                                                |

독립 리뷰에서 발견한 문제는 수정 후 재검토했다. 검증 중 실패한 시도도 `.tmp/completion-audit/failed-attempts/`에 남겼으며, threshold·sample 수를 완화하거나 인증/authoritative 모드를 꺼서 통과시키지 않았다. 로컬 로그는 git-ignored `.tmp/completion-audit/`, 공개 가능한 측정 근거는 [`artifacts/completion-audit`](../artifacts/completion-audit/)에 있다.

검증이 만든 project/label 범위의 container·network·volume과 임시 app process는 최종 조회에서도 잔존 0건이다. Travel Cloud 임시 credential도 제거했으며 기존 사용자 인프라는 정리 대상으로 삼지 않았다. 재현용 `file-server/*:local` build 이미지는 유지한다.

## 2. 확인하고 수정한 문제

### 운영·설정·빌드

- reconciliation이 `intervalMs`를 읽고도 다른 필드로 실행하던 문제를 수정했다. `IMAGE_RECONCILIATION_INTERVAL_MS`가 우선이며 `BATCH_SLEEP_MS`는 주기가 없는 이전 배포의 폐기 예정 별칭이다.
- 활성 telemetry/lifecycle consumer의 broker 누락이 `disabled/ready=true`가 되던 fail-open을 제거했다. 이제 설정/부팅을 거부하며 명시적 비활성과 test 기본 비활성만 보존한다.
- 관리자 Next 페이지 6개의 불허 named export를 `page-content.tsx`로 분리했다. UI·정렬·fetch·auth 동작은 유지하고 `next typegen`을 기본 타입검사에 포함했다.
- 누락된 lifecycle/ACL/script CI gate를 추가하고 기본 TypeScript를 사용한다. TS7 script는 실행하지 않았다.
- 배포를 storage readiness → resize readiness → cache readiness로 정렬했다. 세 서비스는 host **127.0.0.1**에만 publish하고, FILE_SERVER_NET에서 생성 후 Kafka network에 붙여 시작한다. cache Kafka 연결 누락과 불필요한 default bridge를 제거했다.

### 수명주기와 조회

- filesystem walker의 locale 정렬과 binary cursor 비교가 달라 대문자·prefix 경로가 영구 누락되던 문제를 수정했다. object/staging/inbound 모두 같은 binary 상대경로 순서와 cursor를 사용한다.
- Pending/Deleting backlog가 두 Ready queue를 굶기던 문제를 수정했다. reconciliation batch는 **최소 3**이며 매 호출 세 lane에 최소 한 자리를 보장한다. `RepeatableRead` snapshot·선택 ID 제외·bounded 재분배로 중복과 owner 교체 시 기아를 피한다. 기존 설정 1/2는 3 이상으로 변경해야 한다. backfill batch와는 다르다.
- Prisma keyset의 OR 조건에 동치인 `occurredAt <= cursor` 상한을 추가했다. PostgreSQL이 앞쪽 데이터를 훑지 않고 composite index boundary에서 시작한다. opaque cursor/필터/동일 시각 eventId 정렬 계약은 바꾸지 않았다.
- telemetry-only 시절에 멈춰 있던 app benchmark fixture를 authoritative ImageAsset 경로로 보강했다. 격리 benchmark schema에 실제 migrated table 형태를 복제하고 upload 5,000개를 Ready asset으로 만들어, 비어 있지 않은 실제 repository 결과를 측정한다.

### 검증 fixture 자체의 보정

capacity는 별도 ON_DEMAND tenant를 사용해 기존 20개 PRE_GENERATE 설정이 수만 개 job을 만드는 간섭을 차단했다. timestamp bind는 UTC ISO로 고정하고 실제 normalizer로 canonical filename을 확인한다. 이는 production의 경로 검증을 완화하거나 실패를 무시한 것이 아니다.

## 3. 성능 측정값

### 100만 telemetry row

동일 disposable PostgreSQL에서 warmup **5회**, sample **20회**, 요청당 `take=50`으로 실행했다.

| 측정                         |          p95 |     기준 |
| ---------------------------- | -----------: | -------: |
| 첫 페이지 Prisma 목록        |   **5.42ms** |   ≤300ms |
| 중간 cursor Prisma 목록      |   **6.47ms** |   ≤300ms |
| 24시간 dashboard aggregation |  **95.02ms** | ≤1,000ms |
| 실제 compiled admin summary  |  **74.87ms** | ≤1,000ms |
| 실제 compiled time series    | **134.09ms** | ≤1,000ms |
| authoritative top images     | **124.59ms** |   ≤300ms |

요청당 최대 RSS 증가는 **946,176 bytes (약 0.90MiB)**로 100MiB 기준을 충족했다. 실제 Prisma가 발행한 SQL과 parameter를 그대로 `EXPLAIN (ANALYZE, BUFFERS)`에 넣었으며 첫/중간 페이지 모두 index scan의 방문 행은 **51개**, filter/recheck 제거 행은 **0개**였다. 단순히 Node가 51개를 materialize했다는 주장과 구분한다. migration 전후 equivalent SQL plan 및 실제 application plan은 [telemetry-1m.json](../artifacts/completion-audit/telemetry-1m.json)에 있다.

[app-probe-1m.json](../artifacts/completion-audit/app-probe-1m.json)은 authoritative asset **5,000개**, 대표 결과 **50개**, 전부 `Ready`임을 기록한다. 빈 결과나 legacy fallback만 측정하지 않았다. 초기 동시 부하 실행의 중간 페이지 p95 425.15ms 실패도 보존했다. 최종 측정은 lifecycle/빌드 부하와 분리한 것이므로 두 숫자의 차이를 오직 query 변경만의 효과라고 단정하지 않는다.

### Reconciliation 용량과 upload

[reconciliation-capacity.json](../artifacts/completion-audit/reconciliation-capacity.json):

- PNG **5,000개**, 50 directories, Ready **3,000개**, Pending **250개**, orphan **1,750개**, missing/checksum sentinel 4개 및 staging/inbound temp
- 프로필: cadence **250ms**, stale **60s**, metadata batch **100**, object scan **1,000**
- eligible fixture의 전체 파일·DB 수렴: **69.503초**, 5분 gate PASS
- 35회 report, 최대 metadata **100개/tick**, orphan 제거 **998개/tick**, tick p95 **3.231초**
- 긴 tick 동안 같은 process의 중복 실행은 합쳐지므로 실제 elapsed를 기록한다. 250ms마다 모든 작업이 완료됐다는 뜻은 아니다.
- 세 lane은 fresh repository 인스턴스에서도 매번 진행한다. 반복 실행 후 결과가 같고 capacity variant/job은 0건이다.
- child RSS **237,305,856 bytes**는 process 1개의 종료 부근 표본이며 peak나 요청당 RSS가 아니다.

이 **명시한 프로필/fixture**의 결과를 기본 cadence 60초, stale 4분 또는 무제한 inventory의 hard 5분 보장으로 일반화하지 않는다. 기본 batch 100으로 3,000개 metadata를 full sweep하려면 최소 30번의 작업이 필요하므로 운영량에 맞춰 주기·batch·scan과 lag alert를 설정한다. directory당 `readdir`의 materialization 비용도 고려한다.

기본 장애 fixture는 **8.363초**, 늦은 Deleted variant 파일은 **102ms**에 복구됐다. 7개 프로세스 중단 경계를 통과했고, upload p95는 variant 0/1/5/20개에서 **72.00 / 88.77 / 78.17 / 123.96ms**로 고정된 비선형 증가 gate를 통과했다.

## 4. 삭제와 배포의 현행 계약

- HTTP delete 200 전: known 원본/variant 파일 정리, `Deleted` metadata와 lifecycle/cache-invalidation outbox transaction 완료.
- HTTP 200 후: Kafka 전달, 모든 cache replica 무효화, 늦은 worker output의 reconciliation 수렴. 응답 즉시 전역 동기 무효화를 보장하지 않는다.
- filesystem은 첫 storage adapter이며 여러 호스트의 독립 local disk 공유/failover는 지원하지 않는다. 선택 단계 6은 수행하지 않았다.
- 지원 ingress는 host Nginx→loopback 또는 같은 FILE_SERVER_NET의 container Nginx→서비스 컨테이너다. remote Nginx에서 세 서비스 host port를 직접 공개하는 경로는 지원하지 않는다.
- 후속 [CI/CD 점검](ci-cd-runbook.md)에서 테스트한 image 재사용, read-only schema preflight, stopped candidate와 전체 container rollback을 추가했다. 기존 컨테이너를 교체하므로 무중단 candidate/switch 배포 보장은 아니다. 실제 운영 credentials·Nginx/TLS·backup/PITR 검증과 migration/backfill/drain/cutover는 운영 적용 절차다. 이를 로컬 테스트 PASS로 대신했다고 주장하지 않는다.

## 5. 재현 명령과 근거 경로

```bash
pnpm db:generate
pnpm exec prisma validate
pnpm all:lint
pnpm all:typecheck
pnpm all:test --force --continue -- --watchman=false --runInBand
pnpm test:scripts
pnpm test:component:e2e --force --continue -- --watchman=false --runInBand
pnpm test:system:e2e
pnpm test:image-lifecycle:system:e2e
pnpm test:kafka:acl:e2e
pnpm all:build
pnpm docker:build
pnpm test:deployment:boundary
pnpm test:docker:smoke
pnpm integration:travel-cloud:verify
```

1M fixture/성능 측정 명령과 환경변수는 [DB runbook](stage3-db-telemetry-runbook.md), migration·backfill·상태 기계와 rollback은 [lifecycle runbook](image-asset-lifecycle-runbook.md), 타 프로젝트 HTTP/Kafka 계약은 [handoff](file-server-integration-handoff.md)를 따른다. 1M/retention은 disposable PostgreSQL에서만 수행한다. 이번 로그는 `.tmp/completion-audit/`, 2026-07의 과거 증거는 `artifacts/stage3-db-telemetry/`로 분리했다.

원래 계획 `.omx/plans/file-server-architecture-remediation.md`도 보정했지만 `.omx/`는 git-ignored이다. 다른 checkout과 AI는 이 tracked 감사 문서와 handoff를 함께 기준으로 삼아야 한다. 최초 권한 차단, fixture 오류, 동시 부하 실패는 삭제하거나 PASS로 포장하지 않고 후속 실제 실행 결과로 해소했다.
