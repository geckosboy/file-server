# File Server Integration Handoff

- 기준일: 2026-07-11
- 기준 상태: 아키텍처 개선 계획의 단계 0~5 구현, authoritative image lifecycle 통합 gate는 clean integrated HEAD에서 실행
- 대상: 이 저장소를 호출하거나 lifecycle 이벤트를 소비할 다른 프로젝트와 해당 프로젝트를 설계하는 AI
- 전체 구조 시각화: [`architecture.html`](architecture.html)
- Travel Cloud 실제 Docker 연동: [`travel-cloud-integration-runbook.md`](travel-cloud-integration-runbook.md)

## 1. 먼저 알아야 할 결론

현재 저장소는 빌드·배포 기준선, HTTP 이미지 경로의 다중 테넌트 권한 경계, Kafka 이벤트 계약·전달 복원력·client topic 격리, DB 중심 telemetry 조회와 bounded retention, 호출 timeout/cache stampede 제어, 실제 dependency health, authoritative asset/variant 수명주기를 확보했다. 공유 object storage는 이후 단계의 범위다.

- API key 인증 뒤 `ClientServicePolicy ∩ key scopes`를 read/upload/delete마다 강제한다.
- canonical storage path와 제한된 glob(`*`, `**`)으로 tenant path 소유권을 판정한다.
- upload stream 중 정책별 크기 제한을 적용하고, PostgreSQL 원자 counter로 replica 공통 rate limit을 적용한다.
- cache key와 cache 무효화 범위는 `clientServiceId`로 격리된다.
- 내부 호출은 원 client API key를 전달하지 않고 audience/action/발급·만료 시각이 포함된 짧은 HMAC signed context만 사용한다.
- 내부 canonical lifecycle topic과 client service별 topic을 분리하며 client principal은 자기 topic만 consume한다.
- canonical/client destination은 동일 payload와 `eventId`를 사용하지만 outbox 상태는 topic별 row로 독립 추적한다.
- storage는 로컬 파일시스템, cache는 프로세스 로컬 메모리를 사용한다.
- `ImageAsset`/`ImageVariant`가 active image 원장이며 telemetry는 사용량/성능 결합 정보다. migration `000010_add_authoritative_image_assets`가 이 원장과 job/reconciliation table을 추가하고 `000011_add_image_asset_backfill_indexes`가 대규모 source scan용 index를 online 생성한다.
- upload 성공 응답은 authoritative write 경로에서 `assetId`와 `variantStatus`를 포함한다. `imageKey`는 현재 source의 storage/public reference이고 `assetId`는 metadata/variant 관계의 primary key다.
- PRE_GENERATE는 source Ready transaction 뒤 durable job ledger/Kafka로 비동기 처리한다. 현재 worker는 filesystem locality 때문에 storage에 colocate한다.
- cache invalidation은 replica별 Kafka consumer가 처리하며 delete lifecycle과 같은 `eventId`를 쓴다.
- telemetry는 운영 관측에 유용하지만 비즈니스 원장으로 사용하면 안 된다.
- telemetry/lifecycle 목록은 opaque keyset cursor를 사용하고 retention scheduler는 production owner가 명시적으로 승인·활성화하기 전에는 실행되지 않는다.

다른 프로젝트는 현재 구현에 직접 결합하지 말고 별도의 `FileServerClient` 또는 gateway adapter 뒤에서 연동해야 한다. Kafka topic/credential은 관리 API와 운영 secret으로 주입받고, `imageKey`/`assetId`, `variantStatus`, transition 중 optional field도 adapter 뒤에서 흡수해야 한다.

Travel Cloud 통합은 Nginx를 고정 reverse proxy로 사용한다. [`docker-compose.travel-cloud-integration.yml`](../docker/docker-compose.travel-cloud-integration.yml)은 PostgreSQL, ACL Kafka, storage/cache/resize/telemetry-api와 Nginx를 함께 실행하고, `pnpm integration:travel-cloud:provision`이 전용 key/policy/subscription/SCRAM credential을 발급한다. 다른 프로젝트는 `.tmp/travel-cloud-integration/travel-cloud.env`를 runtime secret으로만 읽고 commit하지 않는다. HTTP smoke와 실제 external Kafka consumer/ACL 격리 절차는 전용 runbook을 따른다.

## 2. 단계 0~3에서 확보된 기준선

- Node.js `22.15.0`, pnpm `10.15.0`
- storage, resize, cache 컨테이너는 non-root `node` 사용자로 실행
- `.env*` 파일은 Docker build context와 runtime image에 포함되지 않음
- 컴포넌트 E2E 33개 실행
- 실제 PostgreSQL/Kafka와 다음 연쇄를 검증하는 system E2E 제공:
  - 두 client service/key/policy 생성
  - 이미지 upload
  - cache → resize → storage read
  - cache hit
  - 다른 tenant의 read/upload/delete 403
  - 두 cache replica가 공유하는 DB rate limit과 429
  - telemetry/lifecycle Kafka 발행과 PostgreSQL 저장
  - canonical/client lifecycle topic에 동일 `eventId` dual-publish
  - poison payload를 raw base64/error/source topic/partition/offset envelope로 DLQ에 보낸 뒤 다음 정상 이벤트 처리
  - PostgreSQL 중단 중 consumer offset이 저장 전에 전진하지 않고 storage process와 outbox scheduler가 살아 있음
  - PostgreSQL 복구 후 storage health 회복, 동일 telemetry 이벤트 저장·offset 전진, 지연 outbox row `PUBLISHED`와 canonical Kafka 전달
  - 이미지 delete
- 별도 실제 Kafka authorizer E2E에서 client A가 자기 topic은 consume하고 client B topic과 canonical topic은 거부되는 것을 검증
- 추가 보안 기준선:
  - traversal, 이중 인코딩, separator/Unicode 정규화 우회 거부
  - 정책 `maxUploadBytes` 초과 시 413과 임시 파일 미잔존
  - revoke/expire/비활성 service의 정책 재검증
  - admin API/HTTP ingestion/admin-web fail-closed
  - key·정책·subscription 변경 감사 로그(actor/requestId)
- 주요 명령:

```bash
pnpm db:generate
pnpm db:migrate:deploy
pnpm all:lint
pnpm all:test
pnpm test:component:e2e
pnpm all:build
pnpm test:image-lifecycle:system:e2e
pnpm test:system:e2e
pnpm test:kafka:acl:e2e
pnpm docker:build
pnpm test:docker:smoke
```

`pnpm test:system:e2e`는 Docker/PostgreSQL/Kafka를 사용하며 poison DLQ와 PostgreSQL outage/redelivery까지 포함한다. `pnpm test:kafka:acl:e2e`는 격리된 실제 Kafka authorizer를 띄우고 허용/거부 ACL과 종료 후 container cleanup을 검증한다. 두 명령은 Docker daemon을 사용할 수 있는 환경에서 실행한다.

단계 3의 retention 활성화, 실제 PostgreSQL 검증, 1M-row 성능 evidence는 [`docs/stage3-db-telemetry-runbook.md`](stage3-db-telemetry-runbook.md)의 순서와 매트릭스를 따른다. 성능 fixture 실행 중에는 retention scheduler를 비활성화하며 결과는 `artifacts/stage3-db-telemetry/benchmark-1m.json`에 남긴다. Node `22.15.0`/PostgreSQL `18.4`, 100만 row, warmup 5회/sample 20회의 최종 application-Prisma 경로에서 first page p95 `4.18ms`, middle cursor page p95 `171.95ms`, 24시간 dashboard p95 `67.15ms`, 최대 요청 RSS 증가 `110,592 bytes`였고, 목록은 `take + 1` sentinel을 포함해 요청당 `51`개 row만 materialize했다. 같은 artifact의 direct-SQL 측정은 EXPLAIN 비교를 위한 보조 evidence이며 first/middle/dashboard p95가 각각 `3.43ms`/`2.59ms`/`67.02ms`였다. 같은 fixture에서 실제 compiled `PrismaAdminAnalyticsRepository`를 실행한 `app-probe-1m.json`도 summary p95 `122.37ms`, timeseries p95 `168.99ms`, top images p95 `90.83ms`와 RSS gate를 모두 통과했다.

적용해야 할 Prisma migration은 `prisma/migrations/000001_init`부터 `000011_add_image_asset_backfill_indexes`까지다. 특히 `000003`은 lifecycle event/idempotency 저장소, `000004`는 client subscription, `000005`는 lifecycle outbox, `000007`은 tenant rate-limit/audit, `000008`은 `(event_id, topic)` destination별 outbox 상태·lease/dead-letter와 subscription의 topic/principal/provisioning 상태를 추가하며 `000009`는 단계 3 query/keyset/retention용 index를 추가한다. `000010`은 `ImageAsset`/`ImageVariant`/`ImageVariantJob`, reconciliation lease/metric과 관련 enum/index를 expand-only로 추가한다. `000011`은 telemetry/lifecycle source에 image asset backfill composite index를 `CREATE INDEX CONCURRENTLY`로 추가한다. 배포 전에 `DATABASE_URL`을 설정하고 `pnpm db:migrate:deploy`를 실행하고 두 index의 `pg_index.indisvalid/indisready=true`를 확인한다. interrupted build로 INVALID index가 남으면 runbook대로 migration transaction 밖에서 `DROP INDEX CONCURRENTLY`, `migrate resolve --rolled-back`, deploy 재실행 순서로 복구한다. backfill·switch가 끝나도 이 단계에서 destructive contract migration을 실행하지 않는다.

## 3. 현재 서비스 경계

| 앱            | 기본 포트 | 책임                                              | 다른 프로젝트가 직접 호출해도 되는가        |
| ------------- | --------: | ------------------------------------------------- | ------------------------------------------- |
| cache         |      3030 | 외부 이미지 read 진입점과 메모리 cache            | 서버 측 adapter를 통해서만 호출             |
| resize        |      3031 | storage 원본 조회와 Sharp 변환                    | 아니오, 내부 호출 전용                      |
| storage       |      3032 | upload/delete, 원본·사전 생성 variant 저장        | 서버 측 adapter를 통해 upload/delete만 호출 |
| telemetry-api |      3100 | telemetry/lifecycle 조회, client service/key 관리 | 운영 제어면을 분리한 서버에서만 호출        |
| admin-web     | 3000 계열 | 운영 UI                                           | 사용자 서비스에서 호출하지 않음             |

일반 read 흐름은 `consumer backend → cache → resize → storage`이다. cache와 resize가 전달하는 내부 client context는 HMAC 서명을 사용한다.

## 4. 현재 HTTP 계약

### 4.1 공통 인증

외부 요청은 다음 헤더 중 하나를 사용한다.

```http
x-client-api-key: <issued key>
```

또는:

```http
Authorization: Bearer <issued key>
```

권고사항:

- API key는 브라우저, 모바일 앱, 로그, analytics payload에 노출하지 않는다.
- 다른 프로젝트의 backend가 secret manager 또는 서버 환경변수로 보관한다.
- 선택적으로 `x-request-id`, `x-trace-id`를 전달하고 서비스 로그와 도메인 로그에 동일 ID를 남긴다.

외부 adapter는 원 client API key를 cache → resize → storage 내부 hop으로 전달하지 않는다. file-server 내부 서비스만 공유 `INTERNAL_API_KEY`로 다음 헤더를 생성·검증한다.

- `x-internal-api-key`
- `x-internal-client-context`: client service/key identity, request/trace ID, `audience`, `action`, `issuedAt`, `expiresAt`의 base64url payload
- `x-internal-client-context-signature`: 위 payload의 HMAC signature

기본 TTL은 30초이고 최대 60초다. 수신 route는 signature뿐 아니라 기대한 audience/action과 발급·만료 시각을 함께 검증한다. 다른 프로젝트가 이 내부 헤더를 직접 만들거나 `INTERNAL_API_KEY`를 공유받아서는 안 된다.

권한 계산:

- `ClientServicePolicy`가 서비스 권한의 원본이며 key `scopes`는 권한을 넓히지 못하고 좁히기만 한다.
- 정책 경로는 upload/delete의 canonical storage path 기준이다. 예: `catalog/products/image`, `catalog/**/image`.
- read URL의 `:path`는 `/image`를 제외하지만 서버가 canonical path로 바꾼 뒤 같은 정책을 평가한다.
- 정책이 없거나 pattern/action이 맞지 않으면 기본 거부(403)다.
- rate limit은 key/action/UTC minute 단위이며 모든 replica가 PostgreSQL counter를 공유한다.

### 4.2 Upload

```http
POST {STORAGE_BASE_URL}/image
Content-Type: multipart/form-data
x-client-api-key: ...
Idempotency-Key: <stable business upload key>
```

multipart 필드:

| 필드              | 필수   | 설명                                                               |
| ----------------- | ------ | ------------------------------------------------------------------ |
| `file`            | 예     | 이미지 파일                                                        |
| `path`            | 예     | 현재는 마지막 segment가 반드시 `image`여야 함. 예: `catalog/image` |
| `externalImageId` | 아니오 | 양의 정수 legacy 연계 ID                                           |
| `beforeName`      | 아니오 | 교체 시 삭제할 이전 저장 파일명                                    |

`path`는 stream 저장 전에 권한과 크기 제한을 결정해야 하므로 multipart에서 `file`보다 먼저 전송해야 한다. `beforeName`을 사용하면 같은 path의 delete 권한도 필요하다.

`Idempotency-Key`는 안전한 upload retry를 위한 계약이다. trim 후 최대 256자이며 control character를 허용하지 않는다. 서버는 client service namespace와 함께 hash하고 `(clientServiceId, idempotencyKey)` unique row로 retry를 수렴시킨다. 같은 key에는 같은 path/name/originalName/contentType/inputBytes/externalImageId identity를 사용해야 한다. Pending row를 만들기 전에는 compressed SHA-256을 알 수 없으므로 동일 byte length의 다른 payload까지 판별하는 계약은 아니며, 호출자는 key를 payload-version과 함께 생성해야 한다.

header가 없을 때 서버는 `externalImageId`, request context의 `requestId`, 마지막으로 random legacy key 순서로 fallback한다. `IMAGE_UPLOAD_IDEMPOTENCY_STRICT=true`이면 header, `externalImageId`, `requestId`가 모두 없을 때 400이다. 다른 프로젝트는 fallback에 의존하지 말고 안정적인 header를 항상 보낸다.

authoritative write 경로의 대표 응답:

```json
{
	"imageKey": "catalog/image/sample.<generated-id>.png",
	"path": "catalog/image",
	"name": "sample.<generated-id>.png",
	"originalName": "sample.png",
	"format": "png",
	"size": 12345,
	"eventId": "uuid",
	"assetId": "authoritative-asset-id",
	"variantStatus": "Pending"
}
```

다른 프로젝트는 저장 파일명을 미리 계산하지 말고 응답의 `assetId`, `imageKey`, `path`, `name`, `eventId`, `variantStatus`를 저장해야 한다. source/variant `name`은 최대 128자, `imageKey`는 최대 384자이며 긴 원본명은 stable suffix 또는 source-name hash를 보존하도록 bounded 된다. consumer가 다시 truncate하면 authoritative metadata와 파일 key가 달라진다.

- `assetId`는 authoritative metadata primary key이며 variant가 이 ID를 FK로 참조한다.
- `imageKey`는 현재 `ImageAsset.storageKey`와 같은 `logicalPath/name` reference다. read/delete 호환 API는 아직 이 값을 사용한다.
- `variantStatus`는 source 상태가 아니라 `Pending | Ready | Failed | NotConfigured`인 파생물 집계 상태다. HTTP 201 시 source는 이미 `Ready`지만 variant는 보통 비동기로 남아 있다.
- authoritative read는 source `ImageAsset=Ready`를 요구하고, pre-generated 응답은 현재 source checksum에 연결된 `ImageVariant=Ready`만 제공한다. `Pending|Failed|Deleting|Deleted` metadata가 있으면 남아 있는 filesystem 파일을 직접 제공하지 않는다.
- 같은 `Idempotency-Key`는 같은 `assetId`와 `imageKey`로 수렴한다. 이미 성공한 upload의 응답 재시도는 같은 completion `eventId`를 반환한다. 성공 전 실패 attempt는 별도의 immutable `image.upload.failed` event ID를 사용하고, 이후 성공은 새 `image.upload.completed` event ID를 source identity로 확정한다.
- transition/rollback에서 `IMAGE_ASSET_METADATA_WRITES_ENABLED=false`인 legacy 응답은 `assetId`와 `variantStatus`를 생략할 수 있다. cutover 전 adapter는 optional로 읽되 authoritative write gate 이후에는 존재를 검증한다.

성공 시점은 `Pending metadata → inbound temp에서 .staging 생성/checksum → final rename → ImageAsset Ready + upload lifecycle outbox + ImageVariant/ImageVariantJob ledger transaction → HTTP 201`이다. 201은 Kafka broker acknowledgement, variant Ready, 모든 cache replica invalidation 완료를 기다리지 않는다.

`beforeName`을 보낸 교체 upload는 새 asset의 Ready transaction 뒤 이전 asset delete까지 await한 다음 201을 반환한다. 이전 delete가 실패하면 새 asset은 이미 durable한데 HTTP는 실패할 수 있으므로, 같은 `Idempotency-Key`로 retry하고 새 key로 중복 upload하지 않는다.

### 4.3 Read/Resize

```http
GET {CACHE_BASE_URL}/image/:path/:name?width=400&height=400&format=webp
x-client-api-key: ...
```

- `width`, `height`: 각각 1~4096, 둘 중 하나만 전달 가능
- `format`: `png | jpeg | webp`
- body는 이미지 binary이며 `Content-Type`을 반드시 확인한다.
- 현재 upload path는 `catalog/image`지만 read route의 `:path`는 `catalog`처럼 마지막 `/image`를 제외한다.
- 이 upload/read path 비대칭은 향후 canonical asset API에서 정리할 예정이므로 도메인 코드에 문자열 조작을 흩뿌리지 말고 adapter 한 곳에서만 처리한다.

### 4.4 Delete

권장 방식:

```http
DELETE {STORAGE_BASE_URL}/image?imageKey=<url-encoded-image-key>
x-client-api-key: ...
```

호환 방식으로 `path`와 `name`을 각각 전달할 수도 있지만, 다른 프로젝트는 upload 응답의 `imageKey`를 사용하는 것이 안전하다.

delete는 authoritative asset과 non-deleted variant를 `Deleting`으로 전이하고 stable `deleteEventId`를 저장한 뒤 원본과 모든 known variant file을 정리한다. final transaction은 variant `Deleted`, incomplete job `Cancelled`, asset `Deleted` tombstone, lifecycle outbox와 cache invalidation outbox를 같은 `eventId`로 기록한다. HTTP 200은 file/DB 정리가 끝난 뒤 반환하지만 Kafka broker나 모든 process-local cache replica를 기다리지 않으므로 cache convergence는 eventual consistency다.

같은 delete 재시도와 이미 없는 file 삭제는 멱등이며 현재 controller는 200을 반환한다. final transaction 전 실패는 asset을 `Deleting`에 유지하고 같은 event ID/failure reason을 보존하여 HTTP retry 또는 reconciliation이 완료한다. worker가 delete 직후 늦게 variant file을 publish하고 중단하더라도 reconciliation은 최근 `Deleted` tombstone의 source/variant key를 일반 orphan-delete flag와 무관하게 다시 제거한다. dual-read 중 metadata가 없는 file은 legacy delete로 fallback하며 이 전환 경로도 Kafka invalidation을 모든 replica group에 발행하고 기존 단일 cache HTTP invalidation을 병행한다. authoritative-only switch 뒤에는 metadata absence를 authoritative absence로 취급하므로 backfill coverage가 선행되어야 한다.

### 4.5 오류와 제어면 계약

- `401`: API key/admin/ingestion 인증 실패
- `403`: 인증은 성공했으나 tenant path 또는 action 정책 위반
- `413`: global 또는 정책별 upload byte 상한 초과. 임시 파일은 제거된다.
- `429`: PostgreSQL 공유 rate limit 초과
- `400`: traversal, 남은 percent-encoding, separator 변형, 잘못된 glob/경로

관리 API:

- access policy 생성: `POST /api/admin/client-services/:id/policies`
- access policy 수정/삭제: `PATCH|DELETE /api/admin/client-services/:id/policies/:policyId`
- 감사 로그 조회: `GET /api/admin/client-services/:id/audit-logs`
- 모든 `/api/admin/**` 요청은 `x-admin-token`이 필요하다.
- HTTP ingestion을 켠 경우 `x-ingestion-token` 또는 Bearer token이 필요하며, 운영 기본값은 비활성이다.
- admin-web 운영 접근은 reverse proxy가 주입하는 `x-file-admin-user`, `x-file-admin-proxy-secret` 경계를 사용한다. 모든 server action이 같은 경계를 재검증한다.
- 운영 필수 설정: telemetry-api의 `TELEMETRY_ADMIN_TOKEN`, admin-web의 `TELEMETRY_API_BASE_URL`, `TELEMETRY_ADMIN_TOKEN`, `ADMIN_WEB_PROXY_SECRET`.

대표 policy payload:

```json
{
	"pathPattern": "catalog/**/image",
	"canRead": true,
	"canUpload": true,
	"canDelete": true,
	"maxUploadBytes": 10485760,
	"rateLimitPerMin": 600,
	"metadata": { "owner": "commerce-team" }
}
```

key 발급 시 `scopes`에 `read|upload|delete` 또는 `actions`, `pathPatterns`를 지정하면 위 service policy보다 더 좁은 권한만 부여된다. 다른 프로젝트는 필요한 action을 명시적으로 요청하되 service policy보다 넓은 scope가 효력을 낼 것이라고 가정하면 안 된다.

## 5. 현재 Kafka 계약

### 5.1 공유 contract와 topic

- telemetry canonical: `file.image.events.v1`
- telemetry poison DLQ: `file.image.events.v1.dlq`
- lifecycle canonical(내부 전용): `file.image.lifecycle.v1`
- lifecycle poison DLQ(내부 전용): `file.image.lifecycle.v1.dlq`
- async variant job: `file.image.variant.jobs.v1`
- async variant poison DLQ: `file.image.variant.jobs.v1.dlq`
- cache invalidation: `file.image.cache-invalidation.v1`
- cache invalidation poison DLQ: `file.image.cache-invalidation.v1.dlq`
- client lifecycle: `file.image.lifecycle.client.<lowercase clientServiceId>.v1`

앱별 복제 타입을 만들지 말고 다음 공유 package를 계약 원본으로 사용한다.

- telemetry: [`@file/telemetry-contracts/events`](../libs/telemetry-contracts/src/events.ts)
- lifecycle: [`@file/telemetry-contracts/lifecycle`](../libs/telemetry-contracts/src/lifecycle.ts)
- lifecycle topic naming: [`@file/telemetry-contracts/lifecycle-topics`](../libs/telemetry-contracts/src/lifecycle-topics.ts)
- variant/cache operation: [`@file/telemetry-contracts/image-operations`](../libs/telemetry-contracts/src/image-operations.ts)
- AsyncAPI: [`docs/asyncapi/file-image-lifecycle.asyncapi.yaml`](asyncapi/file-image-lifecycle.asyncapi.yaml)

두 event contract 모두 `schemaVersion=1`, `eventId`, `eventType`, `occurredAt`, `sourceApp`, `environment`, `imageKey`와 tenant/correlation 필드를 검증한다. lifecycle v1의 현재 union은 `image.upload.completed`, `image.upload.failed`, `image.delete.completed`, `image.delete.failed` 네 종류이며 AsyncAPI와 admin subscription/filter UI도 같은 목록을 사용한다. producer와 consumer는 package의 생성·정규화·검증 함수를 사용해야 하며 `eventId`가 at-least-once 전달의 idempotency key다.

client topic은 요청 body에서 받지 않는다. `clientServiceId`는 `[A-Za-z0-9_-]{1,128}`만 허용하고 서버가 trim/lowercase한 뒤 topic과 `User:file-lifecycle-<lowercase clientServiceId>` principal을 계산한다. subscription 응답의 `topic`, `principal`, `provisioningStatus`, `provisioningError`, `provisionedAt`을 source of truth로 사용한다.

Image lifecycle operation topic은 runtime에서 구성 가능하다. variant producer/worker는 `IMAGE_VARIANT_KAFKA_TOPIC`, worker DLQ는 `IMAGE_VARIANT_KAFKA_DLQ_TOPIC`, storage invalidation publisher/outbox와 cache consumer는 같은 `CACHE_INVALIDATION_KAFKA_TOPIC`, cache poison DLQ는 `CACHE_INVALIDATION_KAFKA_DLQ_TOPIC`을 사용한다. custom 이름은 producer·consumer·ACL·topic bootstrap에 동일하게 적용하고, `scripts/kafka/ensure-image-topics.sh`에 custom topic을 인자로 전달한다.

### 5.2 수동 offset, retry, DLQ

- telemetry와 canonical lifecycle consumer는 `autoCommit: false`다.
- 정상 DB 저장 또는 이미 처리한 `eventId` 확인 후에만 `offset + 1`을 commit한다.
- DB `insert_failed` 또는 예외는 기본 3회, 100ms 간격으로 retry한다. 각각 `TELEMETRY_KAFKA_RETRY_MAX_ATTEMPTS`/`TELEMETRY_KAFKA_RETRY_BACKOFF_MS`, `LIFECYCLE_KAFKA_RETRY_MAX_ATTEMPTS`/`LIFECYCLE_KAFKA_RETRY_BACKOFF_MS`로 조정한다.
- retry가 모두 실패하면 handler가 throw하고 offset을 commit하지 않아 Kafka redelivery를 허용한다.
- 영구 parsing/validation 오류는 retry하지 않고 source topic/partition/offset, key, raw payload base64, error, timestamp를 DLQ에 `acks=-1`로 기록한 뒤 해당 source offset만 commit한다.
- DLQ 기본값은 `<source-topic>.dlq`이며 `TELEMETRY_KAFKA_DLQ_TOPIC`, `LIFECYCLE_KAFKA_DLQ_TOPIC`으로만 override한다. client principal에는 server DLQ 접근권한을 주지 않는다.

event 순서를 전역 순서로 가정하지 않는다. 알 수 없는 optional field는 무시하되 `schemaVersion`을 확인하고, 실패 이벤트 뒤에도 동일 `imageKey`의 후속 이벤트를 허용한다.

### 5.3 lifecycle dual-publish와 outbox

- active subscription이 있으면 storage는 canonical topic과 서버 계산 client topic에 **동일 JSON payload와 동일 `eventId`**를 발행한다.
- `image_lifecycle_outbox`는 `(eventId, topic)` unique row를 사용한다. destination 하나가 성공하고 다른 하나가 실패하면 성공 row를 되돌리거나 새 `eventId`를 만들지 않고 실패 destination만 재시도한다.
- atomic lease owner만 row를 발행한다. 기본 publish interval 5초, batch 25, lease 30초, max attempts 10이며 retry delay는 1분 exponential backoff로 최대 1시간이다.
- max attempts 이후 row는 `DEAD_LETTER`, `deadLetteredAt`, `lastError`로 남는다. 기본 보존은 published 30일, dead-letter 90일이다. 관련 `LIFECYCLE_OUTBOX_*` 환경변수는 [`apps/storage/.env.local.example`](../apps/storage/.env.local.example)을 따른다.
- `DEAD_LETTER`는 미발행 active row가 아니라 재시도가 끝난 terminal Stage 2 상태다. cleanup은 `PUBLISHED`/`DEAD_LETTER`만 작은 batch로 처리하며 `PENDING`/`PUBLISHING`/`FAILED`는 삭제하지 않는다.
- cleanup transaction은 lock timeout과 `FOR UPDATE SKIP LOCKED`를 사용하고 full batch 사이에 sleep한다. delete 시 terminal status/cutoff를 다시 확인해 같은 `eventId`의 retrying destination을 보존한다.
- scheduler는 최초 실행과 모든 publish/cleanup timer promise를 process boundary에서 관찰한다. scheduler-level rejection은 `event=image_lifecycle_outbox_background_task_failed`, `task=publish|cleanup`, error/stack 구조로 기록하고 process 밖으로 unhandled rejection을 전파하지 않는다. row별 Kafka publish 실패는 기존 bounded retry/dead-letter 상태 전이로 처리한다.
- publish/cleanup의 `finally`가 실행 중 flag를 해제하므로 실패한 tick이 scheduler를 고착시키지 않는다. 다음 timer tick이 다시 조회·claim·cleanup을 시도하며 기존 row별 lease, bounded retry, dead-letter, `lastError` 규칙은 그대로 유지된다.

다른 프로젝트 consumer는 topic별 duplicate가 아니라 자신의 client topic 안에서 `eventId` unique constraint/멱등 저장을 구현한다. canonical topic을 함께 consume하지 않는다.

### 5.4 SASL/TLS runtime 설정

file-server producer/consumer와 lifecycle consumer tester는 다음 공통 환경변수를 사용한다.

| 환경변수               | 요구사항                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `KAFKA_CLIENT_BROKERS` | 쉼표로 구분한 broker 목록. provisioning admin은 `LIFECYCLE_TOPIC_ADMIN_BROKERS` 우선 사용 |
| `KAFKA_SSL_ENABLED`    | production external listener에서는 `true`                                                 |
| `KAFKA_SSL_CA_FILE`    | SSL 활성화 시 읽을 수 있는 CA PEM 경로. runtime shared client는 누락 시 시작 실패         |
| `KAFKA_SASL_MECHANISM` | `plain`, `scram-sha-256`, `scram-sha-512` 중 하나                                         |
| `KAFKA_SASL_USERNAME`  | 해당 runtime principal의 username                                                         |
| `KAFKA_SASL_PASSWORD`  | secret manager에서 주입하는 password                                                      |

CA 파일만 주고 SSL을 활성화하지 않거나 SASL 일부 값만 주거나 지원하지 않는 mechanism을 주면 runtime client가 fail-closed한다. TLS는 `rejectUnauthorized=true`다. production compose 외부 listener는 SASL/TLS와 deny-by-default authorizer를 사용하며 실제 secret/PKCS12/CA는 repository에 commit하지 않는다. 앱별 예시는 각 `apps/*/.env.local.example`, broker 예시는 [`docker/kafka.env.example`](../docker/kafka.env.example)을 따른다.

다른 프로젝트 client는 관리 API에서 받은 topic/group과 별도로 전달된 brokers, username/password, mechanism, CA를 모두 환경/secret으로 주입한다. topic, principal, credential을 코드에 하드코딩하지 않는다.

### 5.5 provisioning과 최소 ACL

- lifecycle subscription create/enable 또는 consumer group 변경 시 `KafkaLifecycleProvisionerService`가 서버 계산 topic을 만들고 ACL을 조정한다.
- production은 `LIFECYCLE_TOPIC_PROVISIONING_ENABLED` 미설정 시 자동 provisioning이 활성화된다. 개발/테스트는 기본 `PENDING`이며 명시적으로 `true`로 켤 수 있다.
- 기본 client topic은 partitions 6, replication factor 3, min ISR 2다. `LIFECYCLE_CLIENT_TOPIC_PARTITIONS`, `LIFECYCLE_CLIENT_TOPIC_REPLICATION_FACTOR`, `LIFECYCLE_CLIENT_TOPIC_MIN_ISR`로 조정한다.
- client principal에는 자기 literal topic `READ/DESCRIBE`와 등록된 literal consumer group `READ`만 부여한다. group 변경 시 이전 group ACL을 삭제한다.
- 다른 client topic, canonical topic, server DLQ에는 ACL을 주지 않는다. `FAILED` provisioning은 subscription을 비활성화하고 `provisioningError`를 보존한다. 다른 프로젝트는 `PROVISIONED` 전에는 consumer를 운영 배포하지 않는다.

credential secret은 관리 API 응답에 포함하지 않는다. 운영자는 [`scripts/kafka/provision-client-lifecycle-topic.sh`](../scripts/kafka/provision-client-lifecycle-topic.sh) 또는 동등한 cluster/secret-manager automation으로 SCRAM-SHA-512 credential과 최소 ACL을 만들고 별도 보안 채널로 전달한다. [`scripts/kafka/ensure-image-topics.sh`](../scripts/kafka/ensure-image-topics.sh)는 canonical/DLQ topic bootstrap용이며 client topic 이름을 소비자 입력으로 대체하지 않는다.

## 6. 다른 프로젝트가 지금 가져가야 할 모델

최소한 다음과 비슷한 provider-neutral reference를 도메인에 둔다.

```ts
interface FileReference {
	provider: 'file-server';
	clientServiceId: string;
	assetId?: string; // dual-read/rollback window only optional
	imageKey: string;
	storagePath: string;
	storedName: string;
	originalName: string;
	format: 'png' | 'jpeg' | 'webp' | 'unknown';
	bytes?: number;
	uploadEventId: string;
	status: 'pending' | 'ready' | 'deleting' | 'deleted' | 'failed';
	variantStatus?: 'Pending' | 'Ready' | 'Failed' | 'NotConfigured';
}
```

주의:

- 절대 URL만 저장하지 않는다. CDN/base URL은 환경별로 바뀔 수 있다.
- 사용자가 보낸 원본 filename을 storage identity로 사용하지 않는다.
- `externalImageId`를 file-server의 영구 primary key라고 가정하지 않는다.
- authoritative write 응답에서는 `assetId`를 저장하고 `imageKey`에서 다시 계산하지 않는다. optional 표기는 explicit transition/rollback window를 위한 것이며 cutover 완료 뒤에는 누락을 integration error로 처리한다.
- source `status=ready`와 `variantStatus=Pending|Failed`는 동시에 가능하다. upload 성공을 모든 variant의 즉시 준비로 해석하지 않는다.

권장 adapter 경계:

```ts
interface FileServerClient {
	upload(input: UploadFileInput): Promise<FileReference>;
	read(input: ReadFileInput): Promise<FileReadResult>;
	delete(imageKey: string): Promise<void>;
}
```

도메인 service가 `fetch`, route 문자열, API key header, `/image` suffix를 직접 다루지 않게 한다.

## 7. 다른 프로젝트가 지금 반영해야 할 설계 규칙

1. **서버 측 gateway 사용**
   - frontend/mobile에서 file-server를 직접 호출하지 않는다.
2. **서비스 identity 분리**
   - 개발·스테이징·운영마다 별도 client service/key를 사용한다.
3. **서비스별 path namespace**
   - 단계 1의 policy를 고려해 `서비스명/도메인/image` 형태의 소유 namespace를 미리 정한다.
4. **응답 기반 식별**
   - upload 응답의 `assetId`, `imageKey`, `eventId`, `variantStatus`를 transaction/outbox와 함께 저장한다.
5. **보상 가능한 상태 기계**
   - DB 저장과 file upload는 분산 transaction이므로 `pending → ready/failed` 상태와 재처리 job을 둔다.
6. **멱등 이벤트 처리**
   - lifecycle consumer는 처리한 `eventId` unique constraint를 둔다.
7. **타임아웃과 오류 분류**
   - client adapter에 deadline을 두고 401/403/404/429/5xx를 서로 다른 오류로 모델링한다.
8. **관측 ID 전파**
   - requestId/traceId를 HTTP, 이벤트 처리, 업무 로그에 연결한다.
9. **설정 주입**
   - base URL, API key, Kafka brokers/topic/group은 코드 상수가 아니라 환경 설정이어야 한다.
10. **호환 계층 유지**
    - 단계 1~5 전환 중 구·신 계약을 동시에 지원할 수 있도록 adapter version 또는 feature flag를 둔다.
11. **upload idempotency**
    - 업무 file identity로 안정적인 `Idempotency-Key`를 만들고 timeout/retry에서도 같은 key와 payload identity를 사용한다.
12. **eventual variant/cache**
    - source 201 뒤 variant와 delete 뒤 cache replica convergence를 별도 상태/lag로 모델링한다.

## 8. 구현 단계와 다른 프로젝트에 미치는 영향

### 단계 1 — 테넌트 권한과 제어면 보안 (완료)

적용된 변경:

- `ClientServicePolicy ∩ key scopes` 권한 강제
- read/upload/delete별 path policy와 upload 크기/rate limit
- 교차 tenant 요청 403
- cache key에 `clientServiceId` 포함
- 내부 호출에서 원 client API key 제거
- signed context에 audience/action/expiry 추가
- admin-web, admin API, ingestion API fail-closed

다른 프로젝트 적용 사항:

- 필요한 read/upload/delete 권한과 path pattern을 문서화한다.
- 정상 업무 흐름에서 사용하는 최대 업로드 크기와 예상 분당 요청량을 산출한다.
- 401과 403을 구분하며 403을 404로 재해석하지 않는다.

### 단계 2 — 이벤트 계약과 Kafka 격리

완료된 변경:

- 앱별 telemetry 타입 복제를 공유 contract로 통일
- consumer 수동 offset, retry, DLQ
- lifecycle outbox lease/dead-letter/retention
- server-computed client service별 topic/ACL과 destination별 dual-publish
- production Kafka client SASL/TLS 설정과 deny-by-default broker authorizer
- poison DLQ, PostgreSQL outage/redelivery, 실제 broker ACL isolation E2E

다른 프로젝트 적용 사항:

- topic/credential 교체가 가능한 설정 구조를 둔다.
- `eventId` 중복 제거와 poison event 격리 전략을 둔다.
- 자기 client topic의 메시지를 과거부터 모두 재생해도 안전한 handler를 만든다.
- `provisioningStatus=PROVISIONED`와 secret 전달 완료 전에는 consumer를 운영 배포하지 않는다.

### 단계 3 — Telemetry DB query 전환 (완료)

적용된 변경:

- telemetry/lifecycle 목록 filter/sort/take를 PostgreSQL query로 이동하고 전체 배열 반환을 제거
- 내림차순 `(occurredAt,eventId)` opaque keyset cursor와 bounded `take`; non-negative safe-integer decimal 입력만 legacy offset adapter가 수용한다. 서버가 반환하는 모든 `nextCursor`는 `{v:1,occurredAt,eventId}`의 base64url envelope이며 숫자도 envelope도 아닌 cursor는 400이다. 현재 disable flag는 없고 legacy 제거/gate는 integration follow-up이다.
- dashboard summary/time-series/top image/recommendation을 parameterized PostgreSQL 집계로 이동
- 실제 query 조합과 retention scan을 위한 복합 index 및 1M-row `EXPLAIN (ANALYZE, BUFFERS)` evidence
- telemetry 기본 90일, lifecycle/admin audit 별도 owner-approved 기간의 bounded/idempotent retention
- published/dead-letter outbox cleanup의 multi-batch/sleep/lock-timeout 강화와 active outbox 보존

다른 프로젝트 영향:

- admin API를 호출한다면 offset/page 번호에 의존하지 말고 `nextCursor`를 수용할 수 있게 한다.
- telemetry 보존 기간을 업무 데이터 보존 기간으로 오해하지 않는다.
- opaque cursor를 해석·수정하거나 장기 저장하지 말고 같은 filter/order의 다음 요청에만 그대로 전달한다.
- telemetry/lifecycle은 `occurredAt`, admin audit은 `createdAt` 기준으로 삭제되므로 필요한 업무 원장은 별도 도메인 DB에 보존한다.

### 단계 4 — 호출 복원력과 health

구현된 변경:

- cache → resize → storage idempotent GET의 configurable deadline, bounded retry, 정확한 401/403/404/502/503/504 mapping
- response byte/pixel/Sharp concurrency 상한과 cache singleflight/byte budget
- `/health/live`, `/health/ready`, legacy `/health-check` compatibility adapter
- PostgreSQL/Kafka/upstream/storage read-write readiness indicator
- broker high offset과 consumer group offset 차이 기반 Kafka lag, 최초 connect 실패 reconnect/capped backoff
- upstream/cache/singleflight/lag/DLQ/outbox operational metric
- `GET /api/admin/health`의 image lifecycle metric은 asset/variant `oldestPendingAgeMs`·`oldestDeletingAgeMs`, jobs `oldestActiveAgeMs`·`lagMs`·failure/state count를 DB에서 계산한다. `IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED=true`이면 top-level reconciliation은 Stage 4 `supported=false/orphanCount=null`을 유지하고 실제 값은 transition의 `imageLifecycleSupported`/`imageLifecycleOrphanCount` field로 함께 제공한다.

endpoint, 응답 shape, 환경변수, alert 해석, final integration 검증 순서는 [`stage4-resilience-health-runbook.md`](stage4-resilience-health-runbook.md)를 따른다.

#### 최종 통합 검증

최종 통합 gate는 안정적인 clean HEAD `ef071601e384a532276fa7e37f3a3f6ba36ffd9a`에서 실행했다.

- `pnpm test:system:e2e` — PASS (93s), Kafka outage/recovery, poison DLQ, PostgreSQL redelivery 검증 포함
- `pnpm docker:build` — PASS (293s)
- `pnpm test:docker:smoke` — PASS (38s)

작업 소유 임시 리소스 `fs-system-e2e-38529`와 `fs-docker-smoke-98050`은 container, network, volume, 일치하는 process를 남기지 않고 정리되었다. 동시에 존재한 `travel-cloud-phase0` 리소스는 관련 없는 것으로 기록하고 건드리지 않았다. 로그는 `/tmp/stage4-task20-ef071601e384-20260710T095524Z/{system,docker-build,docker-smoke}.log`에 있다.

다른 프로젝트 영향:

- retry는 멱등 요청에만 적용한다.
- readiness 실패를 사용자 데이터 없음(404)으로 바꾸지 않는다.

### 단계 5 — ImageAsset/ImageVariant 수명주기

구현된 변경:

- authoritative `ImageAsset`, `ImageVariant` metadata
- migration `000010`/`000011`, `assetId ↔ imageKey(storageKey)` 관계, online backfill source index와 admin authoritative query
- stable `Idempotency-Key`, upload 응답 `assetId`/`variantStatus`
- `Pending → temp/.staging/checksum/rename → Ready + lifecycle outbox + variant ledger transaction`과 reconciliation
- 원본/variant/job/cache/metadata 통합 delete, `Deleted` tombstone과 멱등 `Deleting` 재시도
- `(assetId,width,height,format,sourceChecksum)` key의 durable PRE_GENERATE job/Kafka worker
- delete 및 variant-ready invalidation durable outbox와 background replay; variant event ID는 `variant-ready:<jobKey>`
- replica별 cache invalidation consumer, manual offset/bounded retry/poison DLQ
- stale `.staging`/inbound temp cleanup, metadata 없는 object detect와 owner-approved delete gate
- 최근 `Deleted` tombstone key의 늦은 worker output은 일반 orphan-delete gate와 무관하게 bounded reconciliation으로 제거
- asset/variant Pending·Deleting age, recent failure, job/reconciliation lag와 readiness threshold
- upload source를 실행당 한 번 materialize하고 ordinal keyset으로 처리하며, batch delete 확인은 composite-index point probe, 종료 tombstone 처리는 fresh latest-delete temp table 한 번으로 제한한 bounded backfill; max-batch 소진 시 `snapshotComplete=false`, `remaining`, exit code 2
- backfill 뒤 도착한 legacy delete를 `Deleted` tombstone으로 수렴시키고, 모든 writer의 metadata write 전환, legacy in-flight/outbox/Kafka ingestion drain 확인 뒤 `ingestionDrainConfirmed=true`, `cutoverReady=true`, `auditCandidates=0`, `auditTombstoneGaps=0`을 요구하는 final audit
- expand → backfill → write/read switch → non-destructive contract hold

상태 기계, topic/offset 계약, 환경변수, 장애 복구, rollback과 최종 검증은 [`image-asset-lifecycle-runbook.md`](image-asset-lifecycle-runbook.md)를 따른다.

다른 프로젝트 영향:

- upload 직후 모든 variant가 즉시 준비된다고 가정하지 않는다.
- `assetId`, `imageKey`, `eventId`, `variantStatus`를 함께 저장하고 transition 중 field 누락을 adapter에서만 흡수한다.
- timeout retry에 같은 `Idempotency-Key`와 payload identity를 사용한다.
- delete를 즉시 물리 삭제가 아니라 상태 전이로 처리할 수 있게 한다.
- delete 성공 뒤 cache replica 반영은 eventual consistency이며, readiness 실패를 이미지 404로 변환하지 않는다.

## 9. 현재 보장되지 않는 사항

다른 프로젝트가 임시 코드로 보완하거나 영구 전제로 삼아서는 안 되는 항목이다.

- telemetry의 무손실 전달
- storage replica 간 파일 공유
- 모든 호출에 대한 circuit breaker(현재는 deadline/bounded retry이며 circuit breaker는 도입하지 않음)
- 여러 replica/region을 하나로 집계한 전역 health(각 endpoint는 해당 process와 dependency snapshot)
- 현재 로컬 filesystem에서 여러 storage replica가 같은 source/variant file을 공유하거나 임의의 replica worker가 다른 replica의 file을 처리한다는 보장

### PostgreSQL outage 복구 보장과 경계

`pnpm test:system:e2e`는 PostgreSQL 중단 중 telemetry consumer의 committed offset이 message offset을 앞서지 않는 것과 함께 다음 storage outbox 동작을 실제 process/PostgreSQL/Kafka로 검증한다.

- storage child는 종료되지 않고 scheduler의 구조화 실패 로그가 관측된다.
- PostgreSQL 재시작 후 storage health가 응답한다.
- 다음 scheduler tick이 재시도하여 미리 넣은 지연 outbox row가 `PUBLISHED`가 되고 같은 `eventId`가 canonical Kafka topic에 전달된다.
- telemetry의 같은 `eventId`가 저장된 뒤 consumer offset이 전진하며 기존 poison DLQ 검증도 유지된다.

따라서 이전 unhandled background rejection은 Stage 2에서 해결되었고 written contract/단일 storage process outage 경로의 release blocker가 아니다. 이 E2E는 process supervisor 재시작, 여러 storage instance 사이의 failover, 장시간 outage/soak까지 증명하지 않으므로 해당 운영 보장은 별도 배포 환경 검증 대상으로 남는다.

## 10. 연동 전 합의해야 할 체크포인트

### Client service 연동 등록 전

- client service slug/name/owner
- 환경별 API key 발급 책임자와 secret 보관 위치
- 허용 path pattern
- read/upload/delete 권한
- 최대 파일 크기와 rate limit

### Kafka client 연동 등록 전

- 필요한 lifecycle event type
- consumer group 소유자
- subscription의 `topic`/`principal`/`provisioningStatus=PROVISIONED` 확인
- SASL username/password와 TLS CA 전달·회전 책임자
- DLQ 확인 및 재처리 책임

### retention 운영 활성화 전

- `DATA_RETENTION_ENABLED=true` 승인자와 변경 기록
- telemetry/lifecycle/admin audit별 보존 기간 owner
- 삭제 예상 row 수, 실행 창, batch/sleep/lock timeout
- backup/PITR 복구 책임자와 실제 PostgreSQL 검증 evidence

### 단계 5 asset 전환 전

- 다른 프로젝트의 기존 file reference schema
- migration `000010`/`000011` 적용 및 backup/PITR 책임자
- legacy telemetry/lifecycle upload의 `imageKey → assetId` backfill count와 later-delete/conflict 처리
- backfill snapshot 결과가 `snapshotComplete=true`, `remaining=0`인지 확인하고 incomplete exit code 2이면 같은 설정으로 재실행
- `snapshotComplete=true`를 read cutover 완료로 오인하지 않고, 모든 writer가 metadata dual-write 중이거나 legacy write가 freeze된 상태에서 `IMAGE_ASSET_BACKFILL_CUTOVER_AUDIT=true`를 실행
- 마지막 legacy request 시점의 telemetry/lifecycle topic high watermark 기록, lifecycle outbox non-terminal 0, ingestion consumer lag 0, DLQ/terminal failure 처리 확인
- drain evidence가 있을 때만 `IMAGE_ASSET_BACKFILL_INGESTION_DRAIN_CONFIRMED=true`를 설정하고 final audit의 `cutoverReady=true`, `auditCandidates=0`, `auditTombstoneGaps=0` 확인
- write switch 전후 `assetId`/`variantStatus` optional-to-required window
- storage와 telemetry-api의 `IMAGE_ASSET_DUAL_READ_ENABLED` 동시 전환
- `IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED=false` 유지와 향후 owner 승인 조건
- stale inbound temp/`.staging` cleanup limit과 alert owner
- pending/failed/deleted 상태의 사용자 노출 규칙
- variant eventual consistency 허용 시간

## 11. 다른 프로젝트에서 먼저 작성할 계약 테스트

1. API key 누락/오류 시 401
2. 타 tenant path 접근 시 read/upload/delete 모두 403
3. stable `Idempotency-Key`로 upload를 두 번 보내 같은 `assetId`, `imageKey`, `eventId`를 받고 `variantStatus`를 저장
4. 원본 read와 width/height/format variant read
5. 404와 upstream 5xx 구분
6. 동일 lifecycle `eventId`를 두 번 받아도 업무 처리가 한 번만 실행됨
7. canonical/client topic에서 관측한 dual-publish payload와 `eventId`가 동일함
8. poison payload가 raw base64/error/source topic/partition/offset과 함께 DLQ로 이동하고 다음 정상 이벤트를 막지 않음
9. DB 저장 실패 동안 offset이 commit되지 않고 복구 후 같은 이벤트가 redelivery됨
10. 자기 client topic은 consume하지만 다른 client/canonical topic은 authorization 거부됨
11. Kafka brokers/topic/group/SASL credential/CA 교체 후 코드 변경 없이 재연결
12. admin 목록의 opaque `nextCursor`를 같은 filter/order에 전달하고 offset/page number를 추론하지 않음
13. telemetry retention 뒤에도 필요한 업무 이력은 별도 도메인 원장에 남음
14. upload 201 시 source `ImageAsset=Ready`/lifecycle outbox가 이미 commit되었고 variant는 비동기일 수 있음
15. upload 성공 후 업무 DB 저장 실패 시 같은 idempotency key로 보상/reconciliation 가능
16. delete 요청 재시도가 멱등이고 `Deleting → Deleted` 뒤 두 cache replica가 eventual invalidation
17. dual-read on/off에서 legacy field absence와 authoritative-only 결과를 adapter가 구분
18. file-server readiness 실패 시 호출 차단 또는 명시적 degraded 처리

## 12. 다른 AI에게 전달할 프롬프트

아래 내용을 다른 프로젝트의 AI에게 그대로 전달할 수 있다.

```text
이 프로젝트는 별도 file-server 저장소와 연동해야 한다.
먼저 file-server 저장소의 docs/file-server-integration-handoff.md를 읽어라.

목표:
- file-server HTTP/Kafka 구현 세부사항이 도메인에 새지 않도록 adapter/gateway 경계를 설계한다.
- upload마다 stable Idempotency-Key를 보내고 응답의 assetId/imageKey/eventId/variantStatus를 보존하며 lifecycle eventId를 멱등 처리한다.
- 완료된 단계 1 tenant policy, signed internal context, multipart path-before-file 계약을 보존한다.
- 완료된 단계 2의 공유 event contract, 서버 계산 client topic, SASL/TLS, 수동 offset/retry/DLQ,
  동일 eventId dual-publish, provisioning/최소 ACL을 그대로 수용한다.
- 완료된 단계 3의 opaque keyset cursor, DB 집계, bounded retention 계약을 수용한다.
- 완료된 단계 4의 timeout/status/readiness 계약과 단계 5의 async ImageAsset/ImageVariant lifecycle,
  assetId/imageKey 관계, variantStatus, durable delete/cache invalidation을 adapter 뒤에서 수용한다.

금지:
- frontend에 API key 노출
- client topic/principal/credential을 직접 계산하거나 하드코딩
- canonical topic 또는 다른 client topic consume
- 절대 URL만 영구 저장
- 사용자 filename이나 externalImageId를 storage primary key로 사용
- telemetry를 비즈니스 원장으로 사용
- 현재 local filesystem/NodeCache 구조를 영구 인프라로 가정
- imageKey에서 assetId를 계산하거나 source 201을 모든 variant/cache convergence로 해석

산출물:
1. 현재 프로젝트에서 필요한 FileReference와 FileServerClient interface
2. 환경변수/secret/Kafka 설정 목록
3. upload/read/delete/event 처리 sequence
4. 실패·재시도·보상·멱등성 설계
5. provisioningStatus=PROVISIONED gate와 credential rotation/ACL 책임
6. poison DLQ 및 DB outage/redelivery 처리·관측 전략
7. migration 000010/000011의 expand/online-index/backfill/dual-read/write-read switch/contract hold 호환 전략
8. 구현 전 작성할 contract/integration test 목록

불명확한 업무 요구만 질문하고, file-server의 현재 취약한 동작을 정상 계약으로 고정하지 마라.
```
