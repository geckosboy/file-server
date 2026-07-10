# Image Asset Lifecycle 운영 Runbook

- 기준일: 2026-07-11
- 적용 migration: `000010_add_authoritative_image_assets`, `000011_add_image_asset_backfill_indexes`
- 범위: authoritative `ImageAsset`/`ImageVariant`, staged filesystem upload, durable async PRE_GENERATE job, reconciliation, integrated delete/cache invalidation, Image lifecycle health
- 제외: 공유 object storage/CDN, 분산 lock, 독립 variant worker 확장

## 1. 출시 불변식

1. `ImageAsset`과 `ImageVariant`가 파일 존재와 상태의 원장이다. telemetry는 사용량·성능 결합 정보이며 자산 원장이 아니다.
2. upload HTTP 201은 source 파일 승격과 checksum 계산이 끝나고, `ImageAsset=Ready`, upload lifecycle outbox, 필요한 `ImageVariant`/`ImageVariantJob` row가 **한 PostgreSQL transaction으로 commit된 뒤**에만 반환한다.
3. HTTP 201은 variant 생성이나 Kafka publish 완료를 뜻하지 않는다. `variantStatus`로 `Pending | Ready | Failed | NotConfigured`를 구분한다.
4. delete는 `Deleting` tombstone을 먼저 기록하고 파일을 지운 뒤 `Deleted`를 기록한다. Kafka cache invalidation은 HTTP 성공 뒤 eventual consistency로 모든 cache replica에 수렴한다.
5. migration은 expand-only다. backfill·write/read switch가 끝나도 이 단계에서는 legacy telemetry나 새 asset table을 drop하지 않는다.
6. reconciliation의 metadata 없는 파일 자동 삭제는 cutover 전까지 반드시 꺼 둔다.

현재 구현은 로컬 filesystem을 사용한다. source와 variant에 접근해야 하는 storage/worker는 같은 filesystem locality를 가져야 하므로, 공유 filesystem 없이 여러 storage replica가 서로의 job을 처리할 수 있다고 가정하지 않는다.

## 2. migration `000010`/`000011`과 authoritative 계약

`000010_add_authoritative_image_assets`는 기존 table을 제거하지 않고 다음 enum과 table을 추가한다.

- enum
  - `ImageAssetState`: `Pending | Ready | Deleting | Deleted | Failed`
  - `ImageVariantState`: `Pending | Ready | Deleting | Deleted | Failed`
  - `ImageVariantJobState`: `Pending | Processing | Completed | Failed | Cancelled`
- table
  - `image_assets`: owner, idempotency, logical identity, source metadata와 lifecycle 상태
  - `image_variants`: `asset_id` FK, variant spec/storage/checksum과 상태
  - `image_variant_jobs`: durable publish/retry ledger와 worker lease
  - `image_reconciliation_leases`: cross-process reconciliation lease
  - `image_reconciliation_metrics`: 마지막 실행과 누적 repair/failure metric

핵심 unique contract:

- `image_assets(asset_id)`가 authoritative primary key다.
- `image_assets(storage_key)`는 unique이며 현재 `imageKey`와 같은 값이다.
- `(client_service_id, idempotency_key)`는 upload retry를 한 asset으로 수렴시킨다.
- `(client_service_id, logical_path, name)`은 같은 owner의 logical file identity를 보호한다.
- `(asset_id, spec_key)`와 `image_variant_jobs(job_key)`는 variant/job 중복 생성을 막는다.

`000011_add_image_asset_backfill_indexes`는 기존 telemetry/lifecycle ingestion을 오래 막지 않도록 별도 non-transactional migration에서 `CREATE INDEX CONCURRENTLY`로 image asset backfill source index를 만든다. 두 index는 `(event_type, status, client_service_id, image_key, occurred_at DESC, event_id DESC)` 순서이며 backfill의 latest-upload와 later-delete 판정을 지원한다. `000011`이 성공하고 두 index가 `indisvalid=true`, `indisready=true`가 되기 전에는 대규모 backfill을 시작하지 않는다.

### 2.1 `assetId`와 `imageKey`

- `assetId`: DB metadata와 variant 관계의 영구 ID다. client가 계산하거나 파일 경로로 사용하지 않는다.
- `imageKey`: 현재 source의 public/storage reference이며 `ImageAsset.storageKey = logicalPath + '/' + name`이다.
- 둘은 같은 문자열이 아니지만 한 authoritative asset row에서 연결된다. `ImageVariant.assetId`가 source와 모든 variant를 묶는다.
- delete/read 호환 API는 아직 `imageKey`를 사용하므로 연동 프로젝트는 둘 다 저장한다.
- `externalImageId`, 원본 filename, 절대 URL은 primary key가 아니다.
- backfill row의 `assetId`는 `legacy-<md5>` 형식일 수 있으므로 ID 형식에 의미를 부여하지 않는다.
- 새 source/variant `name`은 최대 128자이고 `logicalPath + '/' + name`은 최대 384자다. 긴 원본명은 stable suffix 또는 source-name hash를 보존한 bounded 이름으로 생성되므로 client가 파일명을 재계산하거나 다시 truncate하면 안 된다.

admin image query는 `image_assets.status <> Deleted`를 먼저 읽고 telemetry를 usage projection으로 join한다. `IMAGE_ASSET_DUAL_READ_ENABLED=true`인 동안만 metadata가 없는 legacy upload telemetry를 `assetStatus=Legacy`, `assetId` 없음으로 합친다.

## 3. upload 계약과 성공 시점

요청자는 재시도마다 같은 payload identity와 같은 `Idempotency-Key`를 보낸다.

```http
POST /image
Idempotency-Key: order-123-product-456-main-v1
x-client-api-key: <issued-key>
Content-Type: multipart/form-data
```

`Idempotency-Key`는 trim 후 최대 256자이며 control character를 허용하지 않는다. 서버는 원문을 저장하지 않고 client service namespace와 함께 hash한다. 해석 우선순위는 다음과 같다.

1. `Idempotency-Key` header
2. `externalImageId + clientServiceId + canonical path`
3. signed/auth context의 `requestId + path + originalName`
4. strict mode가 아니면 random legacy fallback

`IMAGE_UPLOAD_IDEMPOTENCY_STRICT=true`이면 1~3 중 어느 것도 없을 때 400이다. 안전한 network retry를 위해 연동 프로젝트는 fallback에 의존하지 말고 header를 항상 보낸다. 같은 key를 다른 path/name/originalName/contentType/inputBytes/externalImageId에 재사용하면 동일 asset으로 덮어쓰지 않고 identity conflict로 실패한다. Pending 생성 전에는 compressed checksum을 알 수 없으므로 같은 길이·metadata의 다른 byte payload까지 비교하는 계약은 아니다. 호출자는 key에 도메인 payload version을 포함하고 이미 성공한 key를 다른 content에 재사용하지 않는다.

authoritative write 경로의 201 응답:

```json
{
	"imageKey": "products/image/sample.<stable-suffix>.png",
	"path": "products/image",
	"name": "sample.<stable-suffix>.png",
	"originalName": "sample.png",
	"format": "png",
	"size": 12345,
	"eventId": "upload-lifecycle-event-id",
	"assetId": "authoritative-asset-id",
	"variantStatus": "Pending"
}
```

`variantStatus` 의미:

- `NotConfigured`: active PRE_GENERATE spec이 없다.
- `Pending`: 하나 이상의 variant가 아직 `Ready`가 아니다.
- `Ready`: 모든 non-deleted variant가 `Ready`다.
- `Failed`: 하나 이상의 variant가 `Failed`다.

같은 idempotency key의 retry는 같은 `assetId`와 `imageKey`로 수렴하며 현재 variant 상태를 다시 계산한다. 이미 성공한 요청의 응답 재시도는 같은 completion `eventId`를 반환한다. 성공 전 실패 attempt는 별도 immutable failure event ID를 사용하며, 이후 성공의 새 completion event ID만 `ImageAsset.sourceEventId`로 확정한다. compatibility rollback으로 `IMAGE_ASSET_METADATA_WRITES_ENABLED=false`인 legacy 경로는 `assetId`/`variantStatus`를 생략하므로, cutover 전 consumer는 이 두 필드를 optional로 읽되 authoritative write switch 완료 gate에서는 필수 존재를 검증한다.

source read는 `ImageAsset=Ready`인 authoritative row만 허용하고, variant read는 현재 source checksum과 spec에 대응하는 `ImageVariant=Ready` row의 storage key만 연다. metadata가 존재하는 `Pending|Failed|Deleting|Deleted` asset/variant는 filesystem 파일이 남아 있어도 제공하지 않는다. metadata 자체가 없는 legacy object만 dual-read 기간에 fallback할 수 있다.

`beforeName` 교체 upload는 새 asset Ready transaction을 먼저 commit한 뒤 이전 asset delete를 await한다. 이전 delete가 실패하면 새 asset은 durable하지만 request는 실패할 수 있다. 이 경우 같은 `Idempotency-Key`로 retry하여 같은 asset을 복구하고 새 key로 중복 upload하지 않는다.

source upload 순서:

```text
ImageAsset Pending
  -> inbound temp에서 per-path .staging 파일 생성
  -> output size/format 확인 + SHA-256 checksum
  -> final path로 rename/promote
  -> transaction:
       ImageAsset Ready
       + upload lifecycle outbox
       + ImageVariant/ImageVariantJob ledger
  -> HTTP 201
  -> persisted job Kafka wakeup/periodic publish
  -> colocated worker claim/generate
  -> ImageVariant Ready | Failed
```

정상 요청의 inbound temp는 request `finally`에서 삭제한다. process crash로 남은 inbound temp와 `.staging` 파일은 reconciliation이 `IMAGE_RECONCILIATION_STALE_AFTER_MS`보다 오래된 항목만 bounded scan으로 제거한다.

## 4. delete 계약과 eventual consistency

현재 endpoint는 `imageKey` 또는 `path + name`을 받는다.

```http
DELETE /image?imageKey=<url-encoded-image-key>
x-client-api-key: <issued-key>
```

authoritative delete 순서:

```text
ImageAsset Ready|Failed
  -> transaction: asset + non-deleted variants = Deleting,
                  stable deleteEventId, cacheVersion increment
  -> source + all known variant files rm(force)
  -> transaction: variants = Deleted,
                  incomplete jobs = Cancelled,
                  asset = Deleted,
                  delete lifecycle outbox,
                  cache invalidation outbox
  -> HTTP 200
  -> outbox Kafka publish
  -> each cache replica invalidates tenant/path/name entries
```

- `Deleted` row는 tombstone으로 남고 admin active image query에서 제외된다.
- 같은 delete를 다시 호출하거나 이미 없는 파일을 `rm(force)`하는 것은 멱등이며 현재 controller는 200을 반환한다.
- 파일 삭제나 final transaction이 실패하면 asset은 `Deleting`에 남고 같은 `deleteEventId`, `failedAt`, `failureReason`을 보존한다. HTTP retry 또는 reconciliation이 같은 transition을 완료한다.
- request-path delete 실패 telemetry는 각 시도마다 별도 immutable `eventId`를 사용한다. persisted `deleteEventId`는 상태 전이와 metric correlation에 유지되며, 성공한 `Deleted` transaction의 lifecycle row와 cache invalidation row는 그 stable ID를 함께 사용한다. 이 분리는 실패 telemetry가 동일 topic의 후속 성공 이벤트를 dedupe하지 않게 한다.
- HTTP 200은 DB/file 정리가 끝났다는 뜻이지만 모든 process-local cache replica가 이미 invalidated되었다는 뜻은 아니다. cache consumer lag/DLQ/outbox 상태로 convergence를 관측한다.
- delete와 worker rename이 겹치고 worker가 DB complete 전에 중단되어 늦은 canonical variant가 생기면 reconciliation이 최근 `Deleted` source/variant key를 일반 orphan-delete flag와 무관하게 bounded 재삭제한다.
- dual-read 중 metadata가 없으면 storage가 legacy delete로 fallback한다. 이 경로도 configured Kafka invalidation을 모든 replica group에 발행하며 기존 단일 cache HTTP DELETE는 짧은 transition adapter로 병행한다. `IMAGE_ASSET_DUAL_READ_ENABLED=false` 뒤에는 metadata absence를 authoritative absence로 취급하므로 backfill coverage가 cutover 선행 조건이다.

## 5. async variant와 Kafka 계약

### 5.1 configurable topic

| 목적               | 기본 topic                             | producer/consumer 설정                                                       |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------- |
| variant job        | `file.image.variant.jobs.v1`           | storage publisher와 worker의 `IMAGE_VARIANT_KAFKA_TOPIC`                     |
| variant poison DLQ | `file.image.variant.jobs.v1.dlq`       | storage worker의 `IMAGE_VARIANT_KAFKA_DLQ_TOPIC`                             |
| cache invalidation | `file.image.cache-invalidation.v1`     | storage publisher/outbox와 cache consumer의 `CACHE_INVALIDATION_KAFKA_TOPIC` |
| cache poison DLQ   | `file.image.cache-invalidation.v1.dlq` | cache consumer의 `CACHE_INVALIDATION_KAFKA_DLQ_TOPIC`                        |

custom topic을 사용하면 producer, consumer, ACL, topic bootstrap 값을 동시에 바꾼다. bootstrap script는 runtime env를 자동으로 해석하지 않으므로 custom 이름을 인자로 전달한다.

```bash
scripts/kafka/ensure-image-topics.sh prod \
	"$IMAGE_VARIANT_KAFKA_TOPIC" \
	"$IMAGE_VARIANT_KAFKA_DLQ_TOPIC" \
	"$CACHE_INVALIDATION_KAFKA_TOPIC" \
	"$CACHE_INVALIDATION_KAFKA_DLQ_TOPIC"
```

기본 이름은 `pnpm kafka:topics:dev` 또는 `pnpm kafka:topics:prod`로 만들 수 있다. production producer/consumer는 auto-create를 사용하지 않는다.

### 5.2 job ledger와 retry

- canonical `jobKey`는 `(assetId, width|auto, height|auto, format, sourceChecksum)`이다.
- Ready transaction이 `ImageVariant`와 `ImageVariantJob(Pending)`를 먼저 commit한다. immediate Kafka publish는 durable source가 아니라 wakeup 최적화다.
- dispatcher는 unpublished `Pending|Failed` row를 `nextPublishAt` 순서로 다시 publish한다. Kafka publish 실패는 row의 `publishAttempts`, `publishLastError`, `nextPublishAt`에 남는다.
- worker는 fixed consumer group과 DB lease로 job을 claim한다. completed job 또는 Ready variant의 duplicate delivery는 no-op이다.
- claim/generate/complete 내부 동작은 기본 3회, 100ms bounded retry를 사용한다.
- processing failure는 job/variant를 `Failed`로 기록한다. `IMAGE_VARIANT_JOB_MAX_ATTEMPTS` 미만이면 `publishedAt`을 비우고 `IMAGE_VARIANT_JOB_RETRY_BACKOFF_MS` 뒤 같은 job을 재발행한다. 기본 terminal attempt는 3회다.
- complete transaction은 job `Completed`, variant `Ready`, `variant-ready:<jobKey>` cache invalidation outbox를 함께 commit한다. 이 transaction 뒤에만 source offset을 commit한다.
- source checksum이 달라진 variant는 같은 job으로 재사용하지 않는다.

### 5.3 짧은 synchronous compatibility window

`IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED=true`는 worker rollback 중에만 사용한다. authoritative upload가 만든 durable job을 request process가 직접 claim하고, filesystem variant를 staging/rename한 뒤 같은 `ImageVariant Ready`/`ImageVariantJob Completed` transaction으로 완료한다. 따라서 authoritative read gate와 `variantStatus=Ready`가 실제 DB 상태와 일치한다. claim/complete가 fenced되면 생성 파일을 보상 삭제하고 해당 variant 결과를 `Failed`로 반환한다. 이 flag는 async ledger를 우회하거나 삭제하지 않으며 정상 운영에서는 worker on + sync compat off를 사용한다.

### 5.4 consumer offset과 poison

variant worker와 cache invalidation consumer는 모두 다음 의미를 사용한다.

- `autoCommit:false`
- durable idempotent DB/cache outcome 뒤 `offset + 1` commit
- JSON/schema poison은 source topic/partition/offset/key, raw base64, error, timestamp를 DLQ에 `acks=-1`로 기록한 뒤 source offset commit
- cache handler의 transient failure는 throw하여 offset을 전진시키지 않음
- variant processing은 bounded retry가 끝나면 `Failed` ledger를 durable하게 기록하고 현재 Kafka offset을 commit한다. terminal attempt 전에는 ledger가 같은 job을 backoff 후 다시 publish한다.
- initial connect/reconnect 실패 중 readiness false

variant job은 fixed group으로 한 worker가 처리한다. cache는 process-local이므로 각 replica가 고유 `CACHE_INVALIDATION_KAFKA_GROUP_ID`를 사용해야 한다. 미지정 기본값은 hostname과 pid를 포함한다.

delete와 variant-ready invalidation은 `image_lifecycle_outbox`의 configured cache topic row로 durable하게 저장된다. upload invalidation은 request 이후 비동기 publish이므로 upload 201의 durable invariant는 source Ready/lifecycle outbox/job ledger까지이며 cache broker acknowledgement까지가 아니다.

## 6. expand → backfill → write/read switch → contract hold

flag 기본값에 의존하지 말고 배포 manifest에서 명시한다. 특히 `IMAGE_ASSET_METADATA_WRITES_ENABLED`와 `IMAGE_ASSET_DUAL_READ_ENABLED`는 값이 없으면 현재 코드에서 enabled로 동작한다.

### 6.1 preflight

1. PostgreSQL backup/PITR, storage filesystem backup, rollback binary를 확인한다.
2. 공유 filesystem이 없으면 storage writer/variant worker를 한 locality로 제한한다.
3. custom topic, ACL, cache replica별 group ID를 확정한다.
4. 기존 telemetry upload row 중 `clientServiceId`/`imageKey` 누락과 later delete 여부를 확인한다.

### 6.2 expand

```bash
pnpm db:generate
pnpm db:migrate:deploy
```

`000010`과 online source index migration `000011`을 적용한 후 호환 binary를 먼저 배포한다.

```sql
SELECT index_class.relname, index_meta.indisvalid, index_meta.indisready
FROM pg_index AS index_meta
JOIN pg_class AS index_class ON index_class.oid = index_meta.indexrelid
WHERE index_class.relname IN (
  'telemetry_events_image_asset_backfill_idx',
  'image_lifecycle_events_image_asset_backfill_idx'
);
```

두 row가 모두 valid/ready가 아니면 `000011`을 applied로 강제 표시하지 않는다. interrupted concurrent build는 INVALID 동명이인을 남길 수 있고 `IF NOT EXISTS`가 이를 건너뛸 수 있으므로, 조회 결과가 invalid/not-ready일 때만 다음 복구 절차를 사용한다.

```bash
# 위 pg_index 조회로 invalid/not-ready임을 먼저 확인한다.
psql "$DATABASE_URL" -c \
  'DROP INDEX CONCURRENTLY IF EXISTS "telemetry_events_image_asset_backfill_idx"'
psql "$DATABASE_URL" -c \
  'DROP INDEX CONCURRENTLY IF EXISTS "image_lifecycle_events_image_asset_backfill_idx"'
pnpm exec prisma migrate resolve --rolled-back 000011_add_image_asset_backfill_indexes
pnpm db:migrate:deploy
```

`DROP INDEX CONCURRENTLY`는 Prisma migration transaction 안에 넣지 않는다. 재배포 뒤 migration row가 한 번만 successful 상태이고 두 index가 valid/ready인지 다시 확인한다.

```dotenv
IMAGE_ASSET_METADATA_WRITES_ENABLED=false
IMAGE_ASSET_DUAL_READ_ENABLED=true
IMAGE_RECONCILIATION_ENABLED=false
IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED=false
IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED=true
```

- storage와 telemetry-api에 같은 dual-read 값을 준다.
- cache consumer를 모든 replica에 먼저 배포하고 configured topic 연결을 확인한다.
- health legacy compat는 기존 `supported=false/orphanCount=null` parser를 위한 짧은 presentation window뿐이다.

### 6.3 backfill

backfill은 `telemetry_events`와 `image_lifecycle_events` 양쪽의 성공한 `image.upload.completed`를 합치고 owner/imageKey별 최신 row를 고른다. 두 source 중 같은 시각 또는 이후의 successful delete tombstone이 있거나 asset identity가 이미 있으면 제외하고 `Ready` asset으로 insert한다. upload source scan/sort는 실행당 한 번만 수행해 session-local temporary candidate table로 materialize하고, 이후 write는 `candidate_ordinal` keyset으로 bounded batch 처리한다. 각 batch의 delete 재검사는 두 source table에 composite-index point probe를 직접 수행하여 전체 delete history를 다시 정렬하지 않는다. batch 종료 시 fresh latest-delete snapshot을 한 번만 temporary table로 materialize하고 `(clientServiceId,imageKey)` primary index/`ANALYZE` 뒤 재사용하여, backfill 뒤 도착한 successful delete를 legacy-backfilled asset/variant `Deleted`, 미완료 job `Cancelled`로 수렴시킨다. `ON CONFLICT DO NOTHING`이므로 재실행 가능하며 loop 종료는 conflict로 줄어들 수 있는 inserted 수가 아니라 selected candidate 수로 판단한다. backfill은 checksum/variant job을 만들지 않으며 이후 reconciliation이 실제 file을 검사해 metadata와 job을 보완한다.

먼저 rollback되는 dry run을 실행한다.

```bash
IMAGE_ASSET_BACKFILL_ENABLED=true \
IMAGE_ASSET_BACKFILL_DRY_RUN=true \
IMAGE_ASSET_BACKFILL_BATCH_SIZE=500 \
IMAGE_ASSET_BACKFILL_MAX_BATCHES=1000 \
IMAGE_ASSET_BACKFILL_SLEEP_MS=100 \
IMAGE_ASSET_BACKFILL_LOCK_TIMEOUT_MS=1000 \
IMAGE_ASSET_BACKFILL_STATEMENT_TIMEOUT_MS=30000 \
pnpm db:backfill:image-assets
```

결과 JSON의 `snapshotComplete`, `candidates`, `selected`, `inserted`, `tombstoned`, `remaining`, `batches`와 예상 count를 비교한 뒤 실제 backfill을 실행한다. `IMAGE_ASSET_BACKFILL_MAX_BATCHES`를 소진하고 candidate가 남으면 `image_asset_backfill_incomplete`, `snapshotComplete=false`, `remaining>0`을 출력하고 exit code 2로 종료한다. 이미 commit된 batch는 유지되므로 같은 명령을 재실행해 현재 snapshot을 끝낸다. `image_asset_backfill_snapshot_completed`는 실행 시작 시점 snapshot만 소진했다는 뜻이며 **read cutover 승인 신호가 아니다**.

```bash
IMAGE_ASSET_BACKFILL_ENABLED=true \
IMAGE_ASSET_BACKFILL_DRY_RUN=false \
IMAGE_ASSET_BACKFILL_BATCH_SIZE=500 \
IMAGE_ASSET_BACKFILL_MAX_BATCHES=1000 \
IMAGE_ASSET_BACKFILL_SLEEP_MS=100 \
IMAGE_ASSET_BACKFILL_LOCK_TIMEOUT_MS=1000 \
IMAGE_ASSET_BACKFILL_STATEMENT_TIMEOUT_MS=30000 \
pnpm db:backfill:image-assets
```

### 6.4 write switch

1. variant/cache topic과 cache replica consumer가 ready인지 확인한다.
2. `IMAGE_ASSET_METADATA_WRITES_ENABLED=true`를 storage에 적용한다.
3. stable `Idempotency-Key` canary upload를 두 번 보내 동일 `assetId`, `imageKey`, `eventId`를 받는지 확인한다.
4. source file checksum, `ImageAsset=Ready`, upload lifecycle outbox, expected variant/job row가 201보다 먼저 commit되는지 확인한다.
5. `IMAGE_VARIANT_KAFKA_ENABLED=true`, `IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED=false`로 async path를 사용한다.
6. 모든 storage writer replica가 metadata write binary/flag로 전환될 때까지 기다린다. 이를 보장할 수 없으면 legacy upload/delete를 freeze하고 마지막 in-flight request가 끝날 때까지 기다린다.
7. 마지막 legacy request 종료 시점의 telemetry/lifecycle canonical topic partition high watermark를 기록한다. `image_lifecycle_outbox`의 `PENDING|PUBLISHING|FAILED`가 0이고 `DEAD_LETTER`가 0이거나 owner가 재처리/폐기를 승인했는지 확인한다. telemetry/lifecycle ingestion consumer의 committed offset이 기록한 모든 high watermark에 도달해 lag=0이고 poison DLQ/terminal ingestion failure가 처리될 때까지 기다린다.
8. 위 drain evidence를 배포 기록에 남긴 뒤에만 `IMAGE_ASSET_BACKFILL_INGESTION_DRAIN_CONFIRMED=true`를 설정한다. delta backfill/final audit을 실행해 `snapshotComplete=true`와 zero gap을 확인한다.

```sql
SELECT status, COUNT(*)
FROM image_lifecycle_outbox
WHERE status IN ('PENDING', 'PUBLISHING', 'FAILED', 'DEAD_LETTER')
GROUP BY status;
```

broker high watermark와 consumer group offset은 Stage 4 admin health의 실제 Kafka lag 값 또는 동일 credential의 `kafka-consumer-groups --describe`로 기록한다. DB row count만으로 ingestion drain을 추정하지 않는다.

```bash
IMAGE_ASSET_BACKFILL_ENABLED=true \
IMAGE_ASSET_BACKFILL_DRY_RUN=false \
IMAGE_ASSET_BACKFILL_CUTOVER_AUDIT=true \
IMAGE_ASSET_BACKFILL_INGESTION_DRAIN_CONFIRMED=true \
IMAGE_ASSET_BACKFILL_BATCH_SIZE=500 \
IMAGE_ASSET_BACKFILL_MAX_BATCHES=1000 \
IMAGE_ASSET_BACKFILL_SLEEP_MS=100 \
IMAGE_ASSET_BACKFILL_LOCK_TIMEOUT_MS=1000 \
IMAGE_ASSET_BACKFILL_STATEMENT_TIMEOUT_MS=30000 \
pnpm db:backfill:image-assets
```

`image_asset_backfill_cutover_ready`, `ingestionDrainConfirmed=true`, `cutoverReady=true`, `auditCandidates=0`, `auditTombstoneGaps=0`만 read switch gate로 사용한다. drain confirmation이 없으면 DB gap이 0이어도 script는 `image_asset_backfill_cutover_incomplete`와 exit code 2를 반환한다. 모든 writer가 dual-write 중이거나 legacy traffic이 freeze되지 않았거나, 기록한 broker high watermark까지 consumer가 drain되지 않았다면 confirmation을 설정하지 않는다. audit가 새 candidate 또는 active later-delete gap을 찾으면 exit code 2이며, 원인을 정리하고 drain부터 다시 확인해 재실행한다.

### 6.5 reconciliation과 read switch

1. `IMAGE_RECONCILIATION_ENABLED=true`, `IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED=false`로 시작한다.
2. full filesystem scan이 반복되어 unexplained Pending/Deleting/Failed/missing Ready가 안정화될 때까지 dual-read를 유지한다.
3. final backfill audit가 `cutoverReady=true`이고 admin의 `assetStatus=Legacy` count가 0이며 storage legacy delete fallback이 더 이상 필요하지 않음을 확인한다.
4. storage와 telemetry-api의 `IMAGE_ASSET_DUAL_READ_ENABLED=false`를 함께 배포한다.
5. legacy health consumer가 전환되면 `IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED=false`로 실제 `supported=true` shape를 노출한다.

### 6.6 contract hold와 orphan delete gate

- 이 단계에서는 old telemetry/lifecycle row나 `image_assets`를 제거하는 destructive contract migration을 실행하지 않는다.
- `IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED=false`가 기본이고 cutover 동안 계속 유지된다.
- 다음이 모두 충족된 뒤에만 owner 승인으로 true를 고려한다.
  - backfill과 authoritative-only read switch 완료
  - 최소 한 번의 전체 object scan 완료
  - orphan 후보를 owner/path/mtime별로 검토하고 false positive가 없음
  - filesystem backup과 즉시 flag rollback 준비
- true는 metadata 없는 stale object를 즉시 삭제하며 quarantine을 제공하지 않는다.

## 7. runtime 설정 기준

현재 example과 코드 기본값에 맞춘 명시적 baseline이다.

```dotenv
# Transition and upload idempotency
IMAGE_ASSET_METADATA_WRITES_ENABLED=true
IMAGE_ASSET_DUAL_READ_ENABLED=true
IMAGE_UPLOAD_IDEMPOTENCY_STRICT=false

# Durable variant publisher and colocated worker
IMAGE_VARIANT_KAFKA_ENABLED=true
IMAGE_VARIANT_KAFKA_TOPIC=file.image.variant.jobs.v1
IMAGE_VARIANT_KAFKA_DLQ_TOPIC=file.image.variant.jobs.v1.dlq
IMAGE_VARIANT_KAFKA_GROUP_ID=file-image-variant-worker-v1
IMAGE_VARIANT_KAFKA_RETRY_MAX_ATTEMPTS=3
IMAGE_VARIANT_KAFKA_RETRY_BACKOFF_MS=100
IMAGE_VARIANT_JOB_MAX_ATTEMPTS=3
IMAGE_VARIANT_JOB_RETRY_BACKOFF_MS=1000
IMAGE_VARIANT_OUTBOX_PUBLISH_INTERVAL_MS=1000
IMAGE_VARIANT_OUTBOX_PUBLISH_BATCH_SIZE=25
IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED=false

# Storage publisher/outbox and cache replica consumer must match
CACHE_INVALIDATION_KAFKA_TOPIC=file.image.cache-invalidation.v1
CACHE_INVALIDATION_KAFKA_RETRY_MAX_ATTEMPTS=3
CACHE_INVALIDATION_KAFKA_RETRY_BACKOFF_MS=100
CACHE_INVALIDATION_KAFKA_ENABLED=true
CACHE_INVALIDATION_KAFKA_DLQ_TOPIC=file.image.cache-invalidation.v1.dlq
# CACHE_INVALIDATION_KAFKA_GROUP_ID=file-cache-invalidation-v1-<replica-id>

# Durable delete/variant-ready invalidation outbox
LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS=5000
LIFECYCLE_OUTBOX_PUBLISH_BATCH_SIZE=25
LIFECYCLE_OUTBOX_LEASE_DURATION_MS=30000
LIFECYCLE_OUTBOX_MAX_ATTEMPTS=10
LIFECYCLE_OUTBOX_PUBLISHED_RETENTION_DAYS=30
LIFECYCLE_OUTBOX_DEAD_LETTER_RETENTION_DAYS=90

# Reconciliation
IMAGE_RECONCILIATION_ENABLED=true
IMAGE_RECONCILIATION_INTERVAL_MS=60000
IMAGE_RECONCILIATION_BATCH_SLEEP_MS=60000
IMAGE_RECONCILIATION_STALE_AFTER_MS=240000
IMAGE_RECONCILIATION_LEASE_MS=55000
IMAGE_RECONCILIATION_LOCK_TIMEOUT_MS=2000
IMAGE_RECONCILIATION_BATCH_SIZE=100
IMAGE_RECONCILIATION_OBJECT_SCAN_LIMIT=1000
IMAGE_RECONCILIATION_STAGE_CLEANUP_LIMIT=1000
IMAGE_RECONCILIATION_INBOUND_TEMP_CLEANUP_LIMIT=1000
IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED=false
IMAGE_RECONCILIATION_READINESS_MAX_STALENESS_MS=300000
IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED=false

# Readiness thresholds
IMAGE_LIFECYCLE_READINESS_MAX_ACTIVE_STATE_AGE_MS=300000
IMAGE_VARIANT_READINESS_MAX_LAG_MS=300000
IMAGE_ASSET_FAILED_READINESS_THRESHOLD=0
IMAGE_VARIANT_FAILED_READINESS_THRESHOLD=0
IMAGE_VARIANT_JOB_FAILED_READINESS_THRESHOLD=0
```

effective scheduler cadence는 `IMAGE_RECONCILIATION_BATCH_SLEEP_MS`가 제어하고, 값이 없을 때 `IMAGE_RECONCILIATION_INTERVAL_MS`를 fallback으로 사용한다. 4분 stale threshold + 1분 cadence가 5분 detection 목표다.

system harness가 crash boundary를 재현할 때만 `NODE_ENV=test`, `IMAGE_LIFECYCLE_TEST_FAILPOINTS_ENABLED=true`, `IMAGE_LIFECYCLE_TEST_FAILPOINT_ACTION=exit`과 함께 `IMAGE_LIFECYCLE_TEST_FAILPOINT`를 설정한다. 지원 값은 `after-pending`, `after-stage-write`, `before-stage-checksum`, `after-stage-checksum`, `before-promote`, `after-promote`, `before-ready-transaction`, `after-ready-transaction`이다. failpoint가 production/non-test process에 유입되면 upload는 fail-closed한다.

## 8. reconciliation과 health

### 8.1 reconciliation 동작

한 DB lease owner만 다음 bounded 작업을 수행하며 lease를 절반 주기로 갱신한다.

- stale `Pending`
  - final source가 있으면 inspect/checksum 후 `Ready`, lifecycle outbox와 missing variant jobs 복구
  - source가 없으면 `Failed`
- stale `Deleting`
  - 같은 `deleteEventId`로 file delete와 final transaction 재시도
- `Ready` source
  - missing file 또는 checksum 변경이면 `Failed`
  - metadata가 불완전하면 inspect 결과를 채우고 missing jobs 생성
- `Ready` variant
  - missing object 또는 stale source checksum이면 CAS로 `Failed` 처리하고 canonical job을 재큐잉
- 최근 `Deleted` source/variant key
  - worker의 post-rename crash가 남긴 파일을 일반 orphan delete flag와 무관하게 bounded 재삭제
- `.staging`
  - stale file만 cursor/limit으로 삭제
- inbound temp root
  - normal request cleanup을 못 한 stale file만 cursor/limit으로 삭제
- metadata 없는 source/variant object
  - 항상 detect/count
  - `IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED=true`일 때만 삭제

### 8.2 storage `/health/ready`

`operationalMetrics.imageLifecycle`:

- `assets`: 상태별 count, 최근 5분 `recentFailed`, `Pending|Deleting`의 `oldestActiveAgeMs`
- `variants`: 상태별 count, 최근 5분 `recentFailed`, `Pending|Deleting`의 `oldestActiveAgeMs`
- `jobs`: 상태별 count, 최근 5분 `recentFailed`, `Pending|Processing`의 `oldestActiveAgeMs`
- `runtime.variantJobs`: enabled/connected/ready, publish/complete/failure/duplicate, in-flight와 queue age
- `runtime.cacheInvalidationPublisher`: attempt/publish/failure와 last error
- `runtime.assetDeletes`: completed/failed, last persisted event ID/error
- `reconciliation`: `supported`, 마지막 run의 `orphanCount`, 누적 `repairedCount`/`failedCount`, oldest Pending/Deleting age, duration, last run/success/error

`reconciliation.orphanCount`는 raw filesystem object만의 실시간 gauge가 아니다. 마지막 report의 detected orphan, recovered/failed lifecycle state, staged/inbound cleanup 등을 합친 anomaly count다. per-category 판단은 structured reconciliation log의 `recoveredPendingAssets`, `failedAssets`, `failedVariants`, `completedDeletes`, `detectedOrphanObjects`, `removedOrphanObjects`, `removedDeletedObjects`, `removedStagedObjects`, `removedInboundTempFiles`를 사용한다.

telemetry admin의 `GET /api/admin/health`도 실제 PostgreSQL aggregation을 사용한다. `operationalMetrics.imageLifecycle.assets/variants`는 상태 count와 각각의 `oldestPendingAgeMs`, `oldestDeletingAgeMs`를, `jobs`는 상태/failure count와 `oldestActiveAgeMs` 및 같은 값의 `lagMs` alias를 제공한다. `IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED=true`는 이 admin reconciliation presentation에도 적용되어 Stage 4 `supported=false/orphanCount=null`과 `transition.imageLifecycleSupported/imageLifecycleOrphanCount`를 함께 제공한다.

다음이면 image lifecycle readiness가 false다.

- `000010` table/query가 준비되지 않음
- enabled variant worker가 Kafka에 연결되지 않음
- asset/variant `Pending|Deleting` oldest age가 `IMAGE_LIFECYCLE_READINESS_MAX_ACTIVE_STATE_AGE_MS` 초과
- job `Pending|Processing` oldest age가 `IMAGE_VARIANT_READINESS_MAX_LAG_MS` 초과
- 최근 5분 failed asset/variant/job count가 각각 threshold 초과
- reconciliation enabled인데 `supported=true`가 아니거나 `lastError`가 있거나 `lastRunAt`이 `IMAGE_RECONCILIATION_READINESS_MAX_STALENESS_MS`보다 오래됨

top-level storage readiness는 여기에 PostgreSQL, Kafka, filesystem probe도 결합한다. cache `/health/ready`는 `operationalMetrics.cacheInvalidation`의 enabled/connected/ready, processed/invalidated/DLQ/validation/handler failure를 노출하며 enabled consumer가 끊기면 false다.

`IMAGE_RECONCILIATION_HEALTH_LEGACY_COMPAT_ENABLED=true`는 presentation만 `supported=false`, `orphanCount=null`로 유지하고 실제 값은 `transition.imageLifecycleSupported`, `transition.imageLifecycleOrphanCount`, `transition.legacyCompatEnabled`에 둔다. readiness 계산은 숨기기 전 실제 metric을 사용하므로 이 flag는 장애를 우회하지 않는다.

권장 alert:

- asset/variant/job oldest active age 5분 초과
- recent/total failed 또는 cancelled job 증가
- reconciliation `lastError` 또는 stale `lastRunAt`
- structured log의 orphan/stage/inbound cleanup 급증
- cache invalidation disconnect/reconnect, handler failure, poison DLQ 증가
- lifecycle outbox `FAILED|DEAD_LETTER` 증가

## 9. 장애 복구

### Variant publish/worker

1. source `ImageAsset=Ready`, source checksum, `ImageVariant`, `ImageVariantJob`을 확인한다.
2. configured topic/DLQ/group/ACL과 `runtime.variantJobs.connected`를 확인한다.
3. unpublished row의 `publishedAt`, `nextPublishAt`, `publishAttempts`, `publishLastError`를 확인한다.
4. processing failure는 `attempts`, `nextAttemptAt`, `lastError`와 variant `failureReason`을 확인한다.
5. row를 삭제하거나 새 random job key를 만들지 말고 canonical key를 그대로 재발행한다. source checksum이 실제로 바뀐 경우에만 새 checksum identity가 필요하다.
6. poison DLQ는 raw envelope를 validator로 확인한 뒤 원인을 수정하고 replay한다.

### Delete/cache invalidation

1. asset `status`, `deleteEventId`, `deletingAt`, `failureReason`과 known variant file을 확인한다.
2. `Deleting`이면 같은 delete를 retry하거나 reconciliation을 실행한다. 새 event ID를 만들지 않는다.
3. `Deleted`인데 cache가 남으면 configured cache topic의 같은 `eventId` outbox row가 `PENDING|FAILED|DEAD_LETTER|PUBLISHED` 중 무엇인지 확인한다.
4. 모든 cache replica의 unique group/connected/lastProcessedAt을 비교한다.
5. 긴급 완화는 cache replica recycle/local flush다. 단일 replica HTTP invalidation을 전체 convergence로 간주하지 않는다.

### Reconciliation

1. `lastError`, lease owner/token/expiry, last run staleness부터 확인한다.
2. structured report에서 Pending, Deleting, missing Ready, orphan, `.staging`, inbound temp를 분리한다.
3. `IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED=false`를 유지한 채 한 종류씩 복구한다.
4. oldest active age가 5분 안에 감소하지 않으면 write/read traffic을 제한하고 readiness false를 유지한다.

## 10. rollback

1. 즉시 `IMAGE_RECONCILIATION_ORPHAN_DELETE_ENABLED=false`로 고정한다.
2. storage와 telemetry-api에 `IMAGE_ASSET_DUAL_READ_ENABLED=true`를 복구한다.
3. authoritative upload 문제가 있으면 storage의 `IMAGE_ASSET_METADATA_WRITES_ENABLED=false`로 legacy write path를 임시 복구한다. 이때 upload 응답에서 `assetId`/`variantStatus`가 사라질 수 있음을 consumer에 알린다.
4. worker 문제면 `IMAGE_VARIANT_KAFKA_ENABLED=false`로 중지한다. `IMAGE_PREGENERATION_SYNC_COMPAT_ENABLED=true`는 짧고 명시된 rollback window에만 사용한다. request process가 기존 pending job을 claim해 variant/job metadata까지 Ready/Completed로 완료하며 ledger를 삭제하지 않는다.
5. cache consumer rollback 중에는 TTL/replica recycle로 stale window를 제한하고 outbox/DLQ row를 보존한다.
6. binary를 되돌려도 migration `000010`/`000011`이나 backfilled row를 down/drop하지 않는다. 다시 dual-read로 읽고 원인을 수정한다.

rollback 후에도 이미 반환한 `assetId`, `imageKey`, `eventId`를 재사용해야 한다. 같은 업무 upload에 새 idempotency key를 발급해 중복 asset을 만들지 않는다.

## 11. verification gate

### 11.1 targeted

다음은 placeholder 없이 repository root에서 그대로 실행한다.

```bash
pnpm db:generate
pnpm --filter @file/telemetry-contracts test
pnpm --filter @file/database test
pnpm --filter @file/storage test
pnpm --filter @file/cache test
bash scripts/kafka/test/ensure-image-topics.test.sh
pnpm --filter @file/telemetry-contracts build
pnpm --filter @file/storage build
pnpm --filter @file/cache build
```

### 11.2 integrated

Docker daemon을 사용할 수 있는 clean integrated HEAD에서 순서대로 실행한다.

```bash
pnpm all:lint
pnpm all:test
pnpm test:component:e2e
pnpm test:image-lifecycle:system:e2e
pnpm test:system:e2e
pnpm all:build
pnpm docker:build
pnpm test:docker:smoke
```

`pnpm test:image-lifecycle:system:e2e`의 기본 phase는 migration, one-pass/materialized multi-batch backfill과 incomplete/cutover audit, reconciliation, app crash recovery, variant Kafka retry/poison/duplicate, two-replica cache invalidation, delete/worker race와 cleanup을 실제 PostgreSQL/Kafka/process 경로로 검증한다. 2026-07-11 최종 로컬 실행은 11개 migration과 valid/ready source index, 3-row batch-size-1 backfill/재실행, max-batch incomplete dry-run, post-snapshot delete tombstone, DB gap 0이지만 ingestion drain confirmation이 없는 audit의 exit code 2, 그 뒤 지연 lifecycle ingest를 반영한 drain-confirmed zero-gap audit, 7개 crash boundary, reconciliation `9,420ms`, late Deleted variant cleanup `102ms`를 통과했다. variant 개수별 upload p95는 0/1/5/20개에서 각각 `73.19/184.04/129.99/303.12ms`였다. 성공 시 `image_lifecycle_system_e2e_passed` JSON을 출력하고 자신이 만든 Docker container/network/volume을 정리해야 한다.

### 11.3 documentation

```bash
pnpm exec prettier --check docs/file-server-integration-handoff.md docs/image-asset-lifecycle-runbook.md
git diff --check -- docs/file-server-integration-handoff.md docs/image-asset-lifecycle-runbook.md
```
