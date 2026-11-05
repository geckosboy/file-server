# 테스트 계획: 파일서버 관리자 대시보드 MVP

- Status: Draft
- 작성일: 2026-07-01
- 대상 PRD: `.omx/plans/prd-file-admin-dashboard.md`
- 범위: `apps/telemetry-api`, `apps/admin-web`, `libs/telemetry-contracts`
- 구현 상태: 이 문서는 구현 전 테스트 계획이며, 코드 구현은 포함하지 않는다.

## 1. 테스트 원칙

1. 이벤트 계약은 `libs/telemetry-contracts`에서 먼저 고정한다.
2. `telemetry-api`는 Kafka consumer 없이도 service/repository 단위에서 집계 결과를 검증할 수 있어야 한다.
3. Kafka consumer 테스트는 중복 eventId, invalid payload, legacy payload 변환을 반드시 검증한다.
4. `admin-web`은 화면 구성보다 데이터 상태별 렌더링을 우선 검증한다.
5. 기존 파일서버 e2e 흐름은 깨지면 안 된다. 특히 storage upload Kafka emit과 cache hit/miss e2e는 유지되어야 한다. 근거: `apps/storage/test/app.e2e-spec.ts:111-151`, `apps/cache/test/app.e2e-spec.ts:67-94`.
6. 모든 신규 테스트명은 한글로 작성한다.

## 2. 테스트 범위 매트릭스

| 영역 | 테스트 종류 | 목적 | 필수 여부 |
| --- | --- | --- | --- |
| `libs/telemetry-contracts` | unit | event schema, DTO, enum, parser 검증 | 필수 |
| `apps/telemetry-api` consumer | unit/integration | Kafka event 정규화, idempotent insert, validation 실패 처리 | 필수 |
| `apps/telemetry-api` query service | unit/integration | summary/timeseries/events/images 집계 정확성 | 필수 |
| `apps/telemetry-api` REST API | e2e | endpoint query/response/status 검증 | 필수 |
| `apps/admin-web` | component/page test | dashboard/events/images 상태별 렌더링 | 필수 |
| `apps/admin-web` | smoke/e2e | 주요 페이지 접근과 필터 동작 | MVP 선택 |
| 기존 apps | regression | storage/resize/cache 기존 동작 유지 | 필수 |

## 3. `libs/telemetry-contracts` 테스트

### 3.1 Event schema

테스트 파일 후보:

```txt
libs/telemetry-contracts/src/events.spec.ts
```

테스트 케이스:

- `이미지 업로드 완료 이벤트를 표준 스키마로 검증한다`
- `이미지 리사이즈 완료 이벤트에서 크기와 바이트 정보를 검증한다`
- `캐시 hit 이벤트에는 cacheKey가 필요하다`
- `실패 이벤트에는 errorCode와 errorMessage가 필요하다`
- `지원하지 않는 schemaVersion은 거부한다`
- `지원하지 않는 eventType은 거부한다`
- `imageKey가 없으면 path와 name으로 canonical imageKey를 만든다`

검증 항목:

- topic 상수: `file.image.events.v1`
- source app union: `storage | resize | cache`
- status union: `success | failed`
- event type union
- timestamp ISO string 검증
- `durationMs >= 0`
- `inputBytes/outputBytes >= 0`
- `width/height` 범위는 기존 이미지 계약의 1~4096 제한과 일관되어야 한다. 근거: `libs/image-contracts/src/index.ts:16-30`.

### 3.2 API DTO

테스트 파일 후보:

```txt
libs/telemetry-contracts/src/admin-api.spec.ts
```

테스트 케이스:

- `대시보드 기간 쿼리를 ISO 날짜로 검증한다`
- `이벤트 목록 limit은 최대 100으로 제한한다`
- `이미지 목록 정렬 필드는 허용된 값만 받는다`
- `cursor가 없으면 첫 페이지 요청으로 처리한다`

## 4. `apps/telemetry-api` 테스트

### 4.1 Consumer/ingestion unit tests

테스트 파일 후보:

```txt
apps/telemetry-api/src/modules/ingestion/ingestion.service.spec.ts
```

테스트 케이스:

- `신규 이미지 이벤트를 원본 이벤트 테이블에 저장한다`
- `같은 eventId가 다시 들어오면 중복 저장하지 않는다`
- `잘못된 이벤트는 저장하지 않고 validation 실패 카운트를 증가시킨다`
- `업로드 완료 이벤트가 들어오면 image_assets 요약을 갱신한다`
- `캐시 hit 이벤트가 들어오면 image_assets의 total_cache_hits를 증가시킨다`
- `캐시 miss 이벤트가 들어오면 image_assets의 total_cache_misses를 증가시킨다`
- `리사이즈 완료 이벤트가 들어오면 image_variants를 갱신한다`
- `실패 이벤트가 들어오면 total_failures를 증가시킨다`

Fixtures:

```ts
const uploadCompleted = {
  schemaVersion: 1,
  eventId: 'evt-upload-1',
  eventType: 'image.upload.completed',
  occurredAt: '2026-07-01T00:00:00.000Z',
  sourceApp: 'storage',
  environment: 'test',
  imageId: 100,
  path: 'products/image',
  name: 'sample.png',
  imageKey: 'products/image/sample.png',
  format: 'png',
  inputBytes: 1024,
  outputBytes: 800,
  durationMs: 12.5,
  status: 'success',
};
```

### 4.2 Query service tests

테스트 파일 후보:

```txt
apps/telemetry-api/src/modules/admin/admin-query.service.spec.ts
```

테스트 케이스:

- `대시보드 요약에서 캐시 hit율을 계산한다`
- `캐시 이벤트가 없으면 hit율을 null로 반환한다`
- `실패율을 전체 이벤트 대비 실패 이벤트 비율로 계산한다`
- `평균 처리 시간은 durationMs가 있는 이벤트만 기준으로 계산한다`
- `p95 처리 시간을 fixture 기준으로 계산한다`
- `시간대별 집계는 비어 있는 bucket을 0으로 채운다`
- `이벤트 목록은 occurredAt 내림차순으로 페이지네이션한다`
- `이미지 목록은 totalReads 기준으로 정렬한다`
- `이미지 목록은 cacheMisses 기준으로 정렬한다`

### 4.3 REST e2e tests

테스트 파일 후보:

```txt
apps/telemetry-api/test/app.e2e-spec.ts
```

테스트 케이스:

- `GET /api/admin/health 요청에 정상 상태를 반환한다`
- `GET /api/admin/dashboard/summary 요청에 KPI 요약을 반환한다`
- `GET /api/admin/dashboard/timeseries 요청에 시간대별 지표를 반환한다`
- `GET /api/admin/events 요청에 필터링된 이벤트 목록을 반환한다`
- `GET /api/admin/images 요청에 이미지 집계 목록을 반환한다`
- `잘못된 기간 쿼리는 400을 반환한다`
- `limit이 최대값을 넘으면 400 또는 최대값 보정을 수행한다`
- `관리자 인증이 없으면 401을 반환한다`

DB 전략:

- MVP 테스트는 repository abstraction을 두고 in-memory fake repository로 e2e를 시작한다.
- DB migration이 들어가는 단계에서는 PostgreSQL test database를 사용한다.
- 대량 event 성능 테스트는 MVP 이후 별도 성능 테스트로 분리한다.

## 5. `apps/admin-web` 테스트

### 5.1 Page/component tests

테스트 파일 후보:

```txt
apps/admin-web/src/app/dashboard/page.spec.tsx
apps/admin-web/src/app/events/page.spec.tsx
apps/admin-web/src/app/images/page.spec.tsx
```

테스트 케이스:

#### Dashboard

- `대시보드가 KPI 카드를 표시한다`
- `캐시 hit율이 없으면 빈 상태 문구를 표시한다`
- `실패율이 임계값을 넘으면 위험 상태로 표시한다`
- `기간 필터를 변경하면 대시보드 쿼리를 다시 요청한다`

#### Events

- `이벤트 목록을 발생 시각 내림차순으로 표시한다`
- `이벤트 타입 필터를 변경하면 목록 쿼리를 다시 요청한다`
- `실패 이벤트 행에는 에러 메시지를 표시한다`
- `이벤트가 없으면 빈 상태를 표시한다`
- `다음 페이지 버튼은 nextCursor가 있을 때만 활성화된다`

#### Images

- `이미지 목록에 path와 name을 표시한다`
- `캐시 hit율을 퍼센트로 표시한다`
- `요청 수 기준 정렬을 선택할 수 있다`
- `검색어를 입력하면 이미지 목록 쿼리를 다시 요청한다`
- `이미지가 없으면 빈 상태를 표시한다`

### 5.2 API client tests

테스트 파일 후보:

```txt
apps/admin-web/src/lib/telemetry-api.spec.ts
```

테스트 케이스:

- `대시보드 요약 API URL에 기간 쿼리를 포함한다`
- `이벤트 목록 API URL에 필터와 cursor를 포함한다`
- `API가 실패하면 사용자에게 표시할 에러를 반환한다`
- `숫자 지표가 null이면 UI용 fallback 값을 만든다`

### 5.3 Smoke/e2e 후보

MVP에서 Playwright를 바로 추가할지는 구현 단계에서 결정한다. 추가한다면 테스트 케이스는 다음과 같다.

- `관리자가 대시보드에서 이벤트 페이지로 이동한다`
- `관리자가 이벤트 타입을 cache.miss로 필터링한다`
- `관리자가 이미지 목록에서 검색어로 이미지를 찾는다`

## 6. 기존 앱 회귀 테스트

기존 테스트를 유지/확장한다.

### 6.1 Storage

현재 `storage` e2e는 업로드 후 Kafka emit을 검증한다. 근거: `apps/storage/test/app.e2e-spec.ts:111-128`.

추가 후보:

- `업로드 완료 시 표준 이미지 telemetry 이벤트를 발행한다`
- `업로드 실패 시 실패 telemetry 이벤트를 발행한다`
- `기존 legacy uploadResult 이벤트 호환을 유지하거나 명시적으로 제거한다`

### 6.2 Cache

현재 cache e2e는 첫 요청 miss 후 두 번째 요청 hit를 검증한다. 근거: `apps/cache/test/app.e2e-spec.ts:67-94`.

추가 후보:

- `캐시 hit 시 cache.hit 이벤트를 발행한다`
- `캐시 miss 시 cache.miss 이벤트를 발행한다`
- `리사이즈 결과 캐싱 후 cache.stored 이벤트를 발행한다`

### 6.3 Resize

현재 resize service는 처리 시간을 계산하고 로그만 남긴다. 근거: `apps/resize/src/modules/image/image.service.ts:66-76`.

추가 후보:

- `리사이즈 요청 시작 시 resize.requested 이벤트를 발행한다`
- `리사이즈 완료 시 resize.completed 이벤트를 발행한다`
- `리사이즈 실패 시 resize.failed 이벤트를 발행한다`

## 7. 집계 정확성 fixture

공통 fixture:

| eventType | count | durationMs | status |
| --- | ---: | ---: | --- |
| image.cache.hit | 80 | 2 | success |
| image.cache.miss | 20 | 12 | success |
| image.resize.completed | 20 | 50~200 | success |
| image.upload.completed | 5 | 30~100 | success |
| image.resize.failed | 2 | null | failed |

기대값:

- cacheHitRate = 80 / (80 + 20) = 0.8
- failureRate = 2 / 127
- totalResizes = 20
- totalUploads = 5
- p95DurationMs는 duration fixture 배열 기준으로 deterministic하게 계산한다.

## 8. 성능/부하 테스트 기준

MVP acceptance 기준:

- dashboard summary API는 10,000개 event fixture 기준 500ms 이내를 목표로 한다.
- events list API는 index가 있는 필터 기준 300ms 이내를 목표로 한다.
- images list API는 1,000개 image summary 기준 300ms 이내를 목표로 한다.

이 수치는 로컬/CI 환경에 따라 흔들릴 수 있으므로 CI blocking test는 unit 수준으로 두고, 부하 테스트는 별도 스크립트로 둔다.

## 9. 관측/운영 테스트

`telemetry-api` 자체 health/metric:

- Kafka consumer connected 여부
- consumer lag
- DB connection 여부
- event validation failure count
- event insert failure count
- last consumed event timestamp

테스트 케이스:

- `Kafka consumer 상태를 health 응답에 포함한다`
- `DB 연결 실패 시 health가 degraded를 반환한다`
- `validation 실패 카운트를 관리자 health metric에 반영한다`

## 10. 전체 검증 명령

구현 완료 시 다음을 실행한다.

```bash
pnpm install --frozen-lockfile
pnpm all:lint
pnpm all:test
pnpm all:test:e2e
pnpm all:build
pnpm ignored-builds
```

추가 앱 스크립트가 생기면 root scripts에 다음 필터를 추가한다.

```json
{
  "file:telemetry-api": "pnpm --filter @file/telemetry-api",
  "file:admin-web": "pnpm --filter @file/admin-web"
}
```

## 11. 테스트 완료 기준

- 모든 신규 테스트명이 한글이다.
- telemetry event schema invalid case가 최소 5개 이상 있다.
- dashboard summary/timeseries는 deterministic fixture로 검증된다.
- events/images endpoint는 filter, sort, pagination을 모두 검증한다.
- admin-web은 loading/empty/error/success 상태를 모두 검증한다.
- 기존 storage/resize/cache 테스트와 e2e가 계속 통과한다.
- lockfile 검증이 통과한다.
