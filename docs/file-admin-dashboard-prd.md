# PRD: 파일서버 관리자 대시보드 MVP

- Status: Draft
- 작성일: 2026-07-01
- 범위: `apps/telemetry-api`, `apps/admin-web`, `libs/telemetry-contracts`
- 구현 상태: 이 문서는 구현 전 계획 산출물이며, 코드 구현은 포함하지 않는다.

## 1. 배경과 근거

현재 파일서버는 `storage`, `resize`, `cache` 세 앱으로 이미지 저장/조회/리사이즈/캐싱 흐름을 구성한다.

- `storage` 앱은 업로드 파일을 압축 저장하고 처리 시간(`exeTime`)과 결과 크기(`size`)를 계산한다. 근거: `apps/storage/src/modules/image/image.service.ts:64-90`.
- `storage` 앱은 업로드 완료/실패를 표준 telemetry topic `file.image.events.v1`과 Client Service 소비용 lifecycle topic `file.image.lifecycle.v1`로 발행한다. legacy `image-topic` 발행은 제거되었다.
- `storage` 앱 Kafka producer는 `IMAGE_MICROSERVICE`로 등록되어 있고 producer-only 모드다. 근거: `apps/storage/src/modules/image/image.module.ts:13-28`.
- `cache` 앱은 cache key를 생성하고, 캐시 hit면 바로 반환하며 miss면 resize 서버에서 가져온 뒤 캐시에 저장한다. 근거: `apps/cache/src/modules/image/image.service.ts:29-83`.
- `resize` 앱은 storage 서버에서 원본 이미지를 가져와 width/height 기준으로 리사이즈하고 처리 시간을 로그로 남긴다. 근거: `apps/resize/src/modules/image/image.service.ts:59-82`.
- 현재 이미지 조회/업로드 DTO는 `libs/image-contracts`로 공유된다. 근거: `libs/image-contracts/src/index.ts:14-81`.
- repo는 pnpm workspace와 turbo 기반이다. 근거: `package.json:7-25`.
- 기존 e2e 테스트는 업로드 후 Kafka emit 호출과 캐시 hit/miss 흐름을 검증한다. 근거: `apps/storage/test/app.e2e-spec.ts:111-151`, `apps/cache/test/app.e2e-spec.ts:67-94`.

현재 문제는 Kafka 이벤트가 업로드 완료 한 종류에 가깝고, resize/cache/read 단계의 관측 이벤트가 표준화되어 있지 않아 관리자 화면에서 자원 사용량과 병목을 분석하기 어렵다는 점이다.

## 2. 목표

파일서버 운영자가 다음 질문에 답할 수 있는 관리자 대시보드 MVP를 만든다.

1. 어떤 이미지가 얼마나 자주 요청/리사이즈/캐싱되는가?
2. 캐시 hit율과 miss율은 시간대별로 어떻게 변하는가?
3. 저장/리사이즈/조회 처리 시간은 평균, p95 기준으로 어느 정도인가?
4. 실패한 이미지 처리 이벤트는 무엇이고 어떤 파일/요청에서 발생했는가?
5. 자주 요청되는 이미지와 비효율적인 이미지 변환 조합은 무엇인가?

## 3. 비목표

MVP에서 제외한다.

- 파일 삭제/재처리/캐시 무효화 같은 destructive 관리 액션
- 인증/권한의 전체 구현. 단, 관리자 API 보호가 필요하다는 요구는 명시한다.
- ClickHouse 도입. 초기 저장소는 PostgreSQL 기준으로 설계한다.
- 실시간 websocket 대시보드. MVP는 polling 기반 조회로 충분하다.
- 제품 사용자/어드민 화면과의 통합. 이 대시보드는 파일서버 운영 도구다.

## 4. 성공 기준

- 운영자는 `/dashboard`에서 최근 24시간 기준 요청 수, 캐시 hit율, 평균/p95 처리 시간, 실패율을 확인할 수 있다.
- 운영자는 `/events`에서 기간, 이벤트 타입, source app, path/name, status로 원본 이벤트를 검색할 수 있다.
- 운영자는 `/images`에서 요청량/리사이즈량/캐시 miss가 많은 이미지 목록을 확인할 수 있다.
- `telemetry-api`는 Kafka 이벤트를 idempotent하게 저장하고 중복 `eventId`를 무시한다.
- `libs/telemetry-contracts`는 event schema와 API response DTO를 타입/검증 계약으로 제공한다.
- MVP 구현 후 `pnpm all:lint`, `pnpm all:test`, `pnpm all:test:e2e`, `pnpm all:build`, `pnpm install --frozen-lockfile`이 통과해야 한다.

## 5. 사용자와 주요 시나리오

### 5.1 사용자

- 파일서버 운영자: 캐시 효율, 처리 지연, 실패율을 관찰한다.
- 백엔드 개발자: API/파일 처리 이슈를 event log와 requestId로 추적한다.
- 서비스 관리자: 많이 쓰이는 이미지와 용량/처리 비용이 큰 파일을 파악한다.

### 5.2 핵심 시나리오

1. 운영자가 `/dashboard`에 접속해 최근 24시간 캐시 hit율과 p95 resize latency를 본다.
2. hit율이 떨어진 시간대를 클릭하거나 필터를 바꿔 `/events`에서 miss 이벤트를 확인한다.
3. `/images`에서 cache miss가 많은 이미지를 정렬해 자주 요청되는 size variant를 확인한다.
4. 실패율이 증가하면 `/events`에서 `status=failed`와 `sourceApp=resize`로 필터링한다.

## 6. 시스템 범위

### 6.1 `libs/telemetry-contracts`

책임:

- Kafka topic 이름, event type 상수, source app 상수 정의
- `ImageTelemetryEvent` discriminated union 정의
- API request query DTO와 response DTO 정의
- dashboard summary, timeseries, event list, image list 계약 정의

패키지 이름:

```txt
@file/telemetry-contracts
```

### 6.2 `apps/telemetry-api`

책임:

- Kafka consumer로 `file.image.events.v1` 구독
- 이벤트 검증/정규화/idempotent insert
- PostgreSQL 저장
- dashboard/events/images 조회 API 제공
- 추후 rollup job 또는 materialized view 관리

MVP에서는 Nest 앱 하나에 consumer와 REST API를 같이 둔다. 이벤트량이 커지면 `telemetry-consumer`와 `telemetry-api`를 분리한다.

### 6.3 `apps/admin-web`

책임:

- Next App Router 기반 관리자 UI
- dashboard/events/images 페이지 제공
- `telemetry-api` REST API 조회
- 기간 필터와 테이블/차트 UI 제공

권장 스택:

- Next.js App Router
- React + TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- TanStack Table
- Recharts

## 7. 이벤트 스키마

### 7.1 Topic

신규 표준 topic:

```txt
file.image.events.v1
```

legacy topic `image-topic`과 key `uploadResult-json` 경로는 제거되었다. 업로드 완료/실패를 다른 서비스에 전달해야 하는 경우 Client Service는 `file.image.lifecycle.v1`을 자기 consumer group으로 소비한다.

### 7.2 Event type

```ts
export const ImageTelemetryEventType = {
  UploadCompleted: 'image.upload.completed',
  UploadFailed: 'image.upload.failed',
  ResizeRequested: 'image.resize.requested',
  ResizeCompleted: 'image.resize.completed',
  ResizeFailed: 'image.resize.failed',
  CacheHit: 'image.cache.hit',
  CacheMiss: 'image.cache.miss',
  CacheStored: 'image.cache.stored',
  ReadCompleted: 'image.read.completed',
  ReadFailed: 'image.read.failed',
} as const;
```

### 7.3 공통 envelope

```ts
export type ImageTelemetryEventBase = {
  schemaVersion: 1;
  eventId: string;
  eventType: ImageTelemetryEventType;
  occurredAt: string;
  receivedAt?: string;

  sourceApp: 'storage' | 'resize' | 'cache';
  environment: 'development' | 'test' | 'production';

  requestId?: string;
  traceId?: string;

  imageId?: number;
  path: string;
  name: string;
  imageKey: string;
  cacheKey?: string;

  width?: number;
  height?: number;
  format?: 'png' | 'jpeg' | 'jpg' | 'webp' | 'unknown';

  inputBytes?: number;
  outputBytes?: number;
  durationMs?: number;

  status: 'success' | 'failed';
  errorCode?: string;
  errorMessage?: string;
};
```

### 7.4 이벤트별 추가 필드

```ts
export type ImageUploadCompletedEvent = ImageTelemetryEventBase & {
  eventType: 'image.upload.completed';
  sourceApp: 'storage';
  status: 'success';
  imageId: number;
  inputBytes: number;
  outputBytes: number;
  durationMs: number;
};

export type ImageResizeCompletedEvent = ImageTelemetryEventBase & {
  eventType: 'image.resize.completed';
  sourceApp: 'resize';
  status: 'success';
  width?: number;
  height?: number;
  inputBytes: number;
  outputBytes: number;
  durationMs: number;
};

export type ImageCacheHitEvent = ImageTelemetryEventBase & {
  eventType: 'image.cache.hit';
  sourceApp: 'cache';
  status: 'success';
  cacheKey: string;
  durationMs?: number;
};

export type ImageCacheMissEvent = ImageTelemetryEventBase & {
  eventType: 'image.cache.miss';
  sourceApp: 'cache';
  status: 'success';
  cacheKey: string;
  durationMs?: number;
};
```

실패 이벤트는 `status='failed'`, `errorCode`, `errorMessage`를 필수로 요구한다.

### 7.5 Key 규칙

Kafka message key:

```txt
{imageKey}:{eventType}
```

`imageKey`는 `path/name`의 canonical string 또는 hash다. MVP에서는 DB 검색 편의를 위해 `path`, `name`, `imageKey`를 모두 저장한다.

## 8. DB 스키마 초안

초기 DB는 PostgreSQL을 기준으로 한다.

### 8.1 `image_telemetry_events`

원본 이벤트 저장 테이블.

```sql
CREATE TABLE image_telemetry_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  source_app TEXT NOT NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,

  request_id TEXT,
  trace_id TEXT,

  image_id BIGINT,
  image_key TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  cache_key TEXT,

  width INTEGER,
  height INTEGER,
  format TEXT,

  input_bytes BIGINT,
  output_bytes BIGINT,
  duration_ms DOUBLE PRECISION,

  error_code TEXT,
  error_message TEXT,
  raw_payload JSONB NOT NULL
);
```

Indexes:

```sql
CREATE INDEX idx_image_events_occurred_at ON image_telemetry_events (occurred_at DESC);
CREATE INDEX idx_image_events_type_time ON image_telemetry_events (event_type, occurred_at DESC);
CREATE INDEX idx_image_events_image_key_time ON image_telemetry_events (image_key, occurred_at DESC);
CREATE INDEX idx_image_events_status_time ON image_telemetry_events (status, occurred_at DESC);
CREATE INDEX idx_image_events_source_time ON image_telemetry_events (source_app, occurred_at DESC);
```

### 8.2 `image_assets`

이미지 단위의 최신 상태/요약 테이블.

```sql
CREATE TABLE image_assets (
  image_key TEXT PRIMARY KEY,
  image_id BIGINT,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT,
  original_bytes BIGINT,
  stored_bytes BIGINT,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_uploaded_at TIMESTAMPTZ,
  last_read_at TIMESTAMPTZ,
  total_events BIGINT NOT NULL DEFAULT 0,
  total_reads BIGINT NOT NULL DEFAULT 0,
  total_resizes BIGINT NOT NULL DEFAULT 0,
  total_cache_hits BIGINT NOT NULL DEFAULT 0,
  total_cache_misses BIGINT NOT NULL DEFAULT 0,
  total_failures BIGINT NOT NULL DEFAULT 0
);
```

Indexes:

```sql
CREATE INDEX idx_image_assets_last_seen ON image_assets (last_seen_at DESC);
CREATE INDEX idx_image_assets_reads ON image_assets (total_reads DESC);
CREATE INDEX idx_image_assets_cache_misses ON image_assets (total_cache_misses DESC);
```

### 8.3 `image_variants`

리사이즈 variant 단위 집계.

```sql
CREATE TABLE image_variants (
  variant_key TEXT PRIMARY KEY,
  image_key TEXT NOT NULL REFERENCES image_assets(image_key),
  width INTEGER,
  height INTEGER,
  format TEXT,
  output_bytes BIGINT,
  resize_count BIGINT NOT NULL DEFAULT 0,
  avg_duration_ms DOUBLE PRECISION,
  p95_duration_ms DOUBLE PRECISION,
  last_resized_at TIMESTAMPTZ
);
```

### 8.4 `image_metric_rollups`

대시보드 조회를 빠르게 하기 위한 시간 단위 집계.

```sql
CREATE TABLE image_metric_rollups (
  bucket_start TIMESTAMPTZ NOT NULL,
  bucket_interval TEXT NOT NULL,
  source_app TEXT,
  event_type TEXT,
  image_key TEXT,

  total_count BIGINT NOT NULL DEFAULT 0,
  success_count BIGINT NOT NULL DEFAULT 0,
  failure_count BIGINT NOT NULL DEFAULT 0,
  total_input_bytes BIGINT NOT NULL DEFAULT 0,
  total_output_bytes BIGINT NOT NULL DEFAULT 0,
  avg_duration_ms DOUBLE PRECISION,
  p95_duration_ms DOUBLE PRECISION,

  PRIMARY KEY (bucket_start, bucket_interval, source_app, event_type, image_key)
);
```

MVP에서는 query-time aggregation으로 시작할 수 있다. 이벤트량이 늘면 hourly rollup job을 추가한다.

## 9. API Endpoint 초안

Base path:

```txt
/api/admin
```

### 9.1 Health

```txt
GET /api/admin/health
```

Response:

```ts
{ ok: true; service: 'telemetry-api'; checkedAt: string }
```

### 9.2 Dashboard summary

```txt
GET /api/admin/dashboard/summary?from=ISO&to=ISO
```

Response:

```ts
{
  range: { from: string; to: string };
  totalEvents: number;
  totalReads: number;
  totalUploads: number;
  totalResizes: number;
  cacheHitRate: number;
  cacheMissRate: number;
  failureRate: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  totalInputBytes: number;
  totalOutputBytes: number;
}
```

### 9.3 Dashboard timeseries

```txt
GET /api/admin/dashboard/timeseries?from=ISO&to=ISO&interval=minute|hour|day&metrics=cacheHitRate,totalResizes,p95DurationMs,failureRate
```

Response:

```ts
{
  interval: 'minute' | 'hour' | 'day';
  points: Array<{
    bucketStart: string;
    totalEvents: number;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number | null;
    resizeCompleted: number;
    uploadCompleted: number;
    failures: number;
    avgDurationMs: number | null;
    p95DurationMs: number | null;
  }>;
}
```

### 9.4 Events list

```txt
GET /api/admin/events
```

Query:

```ts
{
  from?: string;
  to?: string;
  eventType?: string;
  sourceApp?: 'storage' | 'resize' | 'cache';
  status?: 'success' | 'failed';
  path?: string;
  name?: string;
  imageKey?: string;
  requestId?: string;
  cursor?: string;
  limit?: number; // max 100
}
```

Response:

```ts
{
  items: ImageTelemetryEventListItem[];
  nextCursor?: string;
}
```

### 9.5 Images list

```txt
GET /api/admin/images
```

Query:

```ts
{
  from?: string;
  to?: string;
  q?: string;
  sort?: 'reads' | 'resizes' | 'cacheMisses' | 'failures' | 'lastSeenAt';
  order?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}
```

Response:

```ts
{
  items: Array<{
    imageKey: string;
    imageId?: number;
    path: string;
    name: string;
    format?: string;
    totalReads: number;
    totalResizes: number;
    totalCacheHits: number;
    totalCacheMisses: number;
    cacheHitRate: number | null;
    totalFailures: number;
    avgDurationMs: number | null;
    lastSeenAt: string;
  }>;
  nextCursor?: string;
}
```

### 9.6 Image detail

```txt
GET /api/admin/images/:imageKey
GET /api/admin/images/:imageKey/events
GET /api/admin/images/:imageKey/variants
```

MVP 화면은 `/images` 목록 중심이지만, API 계약은 상세 확장을 위해 먼저 잡는다.

## 10. 화면 IA

### 10.1 공통 레이아웃

Navigation:

```txt
Dashboard
Images
Events
Cache       // MVP 이후 상세화
Resize      // MVP 이후 상세화
Storage     // MVP 이후 상세화
```

공통 필터:

- 기간: 최근 1시간, 24시간, 7일, 30일, custom
- source app
- status
- image search: path/name/imageKey

### 10.2 `/dashboard`

구성:

1. KPI cards
   - 총 이벤트 수
   - 캐시 hit율
   - 리사이즈 완료 수
   - 평균 처리 시간
   - p95 처리 시간
   - 실패율
2. Timeseries charts
   - cache hit/miss 추이
   - resize/upload/read 이벤트 추이
   - latency p95 추이
   - failure 추이
3. Top lists
   - 요청 많은 이미지 Top 10
   - cache miss 많은 이미지 Top 10
   - 실패 많은 이미지 Top 10

### 10.3 `/events`

구성:

- 필터 패널
- 이벤트 테이블
  - occurredAt
  - eventType
  - sourceApp
  - status
  - path/name
  - width/height
  - durationMs
  - input/output bytes
  - requestId
- row expand 또는 side panel
  - raw payload JSON
  - errorCode/errorMessage

### 10.4 `/images`

구성:

- 검색/정렬/기간 필터
- 이미지 집계 테이블
  - imageKey
  - path/name
  - totalReads
  - totalResizes
  - cache hit rate
  - failures
  - avg/p95 duration
  - lastSeenAt
- 클릭 시 `/images/[imageKey]` 상세로 이동할 수 있게 라우팅만 준비한다.

## 11. 데이터 보관 정책

MVP 기본값:

- raw event: 30일 보관
- hourly rollup: 180일 보관
- image_assets/image_variants summary: 무기한 또는 운영 정책에 따름

보관 정책은 destructive 삭제와 연결되므로 실제 purge job은 MVP 이후 별도 승인 대상으로 둔다.

## 12. 보안/운영 요구사항

- `telemetry-api` admin endpoint는 외부 공개 금지.
- MVP에서는 내부 네트워크 + admin API key 또는 gateway 인증을 전제로 한다.
- event payload에는 사용자 PII를 넣지 않는다.
- `path`, `name`, `requestId`는 검색 가능하지만 민감 정보가 들어가지 않도록 upstream 정책을 둔다.
- Kafka consumer lag, DB insert 실패율, event validation 실패율은 telemetry-api 자체 health metric으로 노출한다.

## 13. 수용 기준

- `libs/telemetry-contracts`에 topic/event type/source app/API DTO가 정의되어 있다.
- `apps/telemetry-api`는 `/api/admin/dashboard/summary`, `/api/admin/dashboard/timeseries`, `/api/admin/events`, `/api/admin/images`를 제공한다.
- `apps/admin-web`은 `/dashboard`, `/events`, `/images`를 제공한다.
- dashboard KPI 값은 event fixture를 기준으로 deterministic하게 계산된다.
- events API는 cursor pagination과 필터를 지원한다.
- images API는 요청량/cache miss/failure 기준 정렬을 지원한다.
- 모든 테스트명은 한글이다.
- 커밋이 필요할 경우 모든 커밋 메시지는 한글 Lore 형식이다.

## 14. 향후 확장

- `/cache`: cache key별 hit/miss와 warm-up 후보
- `/resize`: variant별 latency와 size 조합 분석
- `/storage`: path별 저장 용량과 orphan 후보
- ClickHouse 도입
- OpenTelemetry trace 연동
- 관리자 액션: cache invalidate, image reprocess, file delete 후보 리뷰
