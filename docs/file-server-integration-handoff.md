# File Server Integration Handoff

- 기준일: 2026-07-10
- 기준 상태: 아키텍처 개선 계획의 단계 0 완료
- 대상: 이 저장소를 호출하거나 lifecycle 이벤트를 소비할 다른 프로젝트와 해당 프로젝트를 설계하는 AI

## 1. 먼저 알아야 할 결론

현재 저장소는 빌드, 테스트, 컨테이너 실행 경로는 재현 가능하게 정비되었지만 아직 다중 테넌트 운영 안전성이 확보된 상태는 아니다.

- 현재 API key 인증은 “유효한 client service key인가”까지만 확인한다.
- `ClientServicePolicy`, key scope, path 소유권은 아직 요청에 강제되지 않는다.
- lifecycle Kafka topic은 모든 client service가 공유한다.
- storage는 로컬 파일시스템, cache는 프로세스 로컬 메모리를 사용한다.
- telemetry는 운영 관측에 유용하지만 비즈니스 원장으로 사용하면 안 된다.

다른 프로젝트는 현재 구현에 직접 결합하지 말고 별도의 `FileServerClient` 또는 gateway adapter 뒤에서 연동해야 한다. 이후 단계에서 인증, path 규칙, Kafka topic, asset 식별 방식이 변경될 예정이다.

## 2. 단계 0에서 확보된 기준선

- Node.js `22.15.0`, pnpm `10.15.0`
- storage, resize, cache 컨테이너는 non-root `node` 사용자로 실행
- `.env*` 파일은 Docker build context와 runtime image에 포함되지 않음
- 컴포넌트 E2E 30개 실행
- 실제 PostgreSQL/Kafka와 다음 연쇄를 검증하는 system E2E 제공:
  - client service/key 생성
  - 이미지 upload
  - cache → resize → storage read
  - cache hit
  - telemetry/lifecycle Kafka 발행과 PostgreSQL 저장
  - 이미지 delete
- 주요 명령:

```bash
pnpm all:lint
pnpm typecheck:ts7
pnpm all:test
pnpm test:component:e2e
pnpm all:build
pnpm test:system:e2e
pnpm docker:build
pnpm test:docker:smoke
```

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

### 4.2 Upload

```http
POST {STORAGE_BASE_URL}/image
Content-Type: multipart/form-data
x-client-api-key: ...
```

multipart 필드:

| 필드              | 필수   | 설명                                                               |
| ----------------- | ------ | ------------------------------------------------------------------ |
| `file`            | 예     | 이미지 파일                                                        |
| `path`            | 예     | 현재는 마지막 segment가 반드시 `image`여야 함. 예: `catalog/image` |
| `externalImageId` | 아니오 | 양의 정수 legacy 연계 ID                                           |
| `beforeName`      | 아니오 | 교체 시 삭제할 이전 저장 파일명                                    |

대표 응답:

```json
{
	"imageKey": "catalog/image/sample.<generated-id>.png",
	"path": "catalog/image",
	"name": "sample.<generated-id>.png",
	"originalName": "sample.png",
	"format": "png",
	"size": 12345,
	"eventId": "uuid"
}
```

다른 프로젝트는 저장 파일명을 미리 계산하지 말고 응답의 `imageKey`, `path`, `name`, `eventId`를 저장해야 한다.

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

현재 delete는 원본 삭제가 중심이며 모든 pre-generated variant와 모든 cache replica의 삭제가 완전하게 보장되지는 않는다. 단계 5에서 asset 단위 삭제로 바뀐다.

## 5. 현재 Kafka 계약

### Topic

- telemetry: `file.image.events.v1`
- lifecycle: `file.image.lifecycle.v1`

### 계약 위치

- telemetry: [`libs/telemetry-contracts/src/events.ts`](../libs/telemetry-contracts/src/events.ts)
- lifecycle: [`libs/telemetry-contracts/src/lifecycle.ts`](../libs/telemetry-contracts/src/lifecycle.ts)
- AsyncAPI: [`docs/asyncapi/file-image-lifecycle.asyncapi.yaml`](asyncapi/file-image-lifecycle.asyncapi.yaml)

### 소비 규칙

- 전달 의미는 at-least-once로 간주한다.
- `eventId`를 idempotency key로 저장하고 중복 처리를 막는다.
- event 순서를 전역 순서로 가정하지 않는다.
- 알 수 없는 optional field는 무시하고 `schemaVersion`을 확인한다.
- 실패 이벤트도 최종 상태가 아닐 수 있으므로 동일 `imageKey`의 후속 이벤트를 허용한다.

### 중요한 보안 경고

현재 공유 lifecycle topic을 client project가 직접 consume하면 다른 client service의 이벤트까지 볼 수 있다. 다른 프로젝트의 설계에서는 공유 topic 이름을 상수로 고정하거나 현재 broker credential을 영구 계약으로 취급하면 안 된다.

단계 2에서 다음 구조로 전환한다.

- 내부 canonical topic: 운영/감사용, client 접근 금지
- client service별 lifecycle topic과 Kafka principal/ACL
- 전환 기간에는 동일 `eventId`로 dual-publish

다른 프로젝트는 topic과 credential을 설정으로 주입받고 `eventId` 중복 제거를 먼저 구현해야 한다.

## 6. 다른 프로젝트가 지금 가져가야 할 모델

최소한 다음과 비슷한 provider-neutral reference를 도메인에 둔다.

```ts
interface FileReference {
	provider: 'file-server';
	clientServiceId: string;
	imageKey: string;
	storagePath: string;
	storedName: string;
	originalName: string;
	format: 'png' | 'jpeg' | 'webp' | 'unknown';
	bytes?: number;
	uploadEventId: string;
	status: 'pending' | 'ready' | 'deleting' | 'deleted' | 'failed';
}
```

주의:

- 절대 URL만 저장하지 않는다. CDN/base URL은 환경별로 바뀔 수 있다.
- 사용자가 보낸 원본 filename을 storage identity로 사용하지 않는다.
- `externalImageId`를 file-server의 영구 primary key라고 가정하지 않는다.
- 향후 `assetId`가 추가될 수 있도록 provider metadata 확장을 허용한다.

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
   - upload 응답의 `imageKey`와 `eventId`를 transaction/outbox와 함께 저장한다.
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

## 8. 향후 단계와 다른 프로젝트에 미치는 영향

### 단계 1 — 테넌트 권한과 제어면 보안

예정 변경:

- `ClientServicePolicy ∩ key scopes` 권한 강제
- read/upload/delete별 path policy와 upload 크기/rate limit
- 교차 tenant 요청 403
- cache key에 `clientServiceId` 포함
- 내부 호출에서 원 client API key 제거
- signed context에 audience/action/expiry 추가
- admin-web, admin API, ingestion API fail-closed

다른 프로젝트 사전 준비:

- 필요한 read/upload/delete 권한과 path pattern을 문서화한다.
- 정상 업무 흐름에서 사용하는 최대 업로드 크기와 예상 분당 요청량을 산출한다.
- 401과 403을 구분하며 403을 404로 재해석하지 않는다.

### 단계 2 — 이벤트 계약과 Kafka 격리

예정 변경:

- 앱별 telemetry 타입 복제를 공유 contract로 통일
- consumer 수동 offset, retry, DLQ
- lifecycle outbox lease/dead-letter/retention
- client service별 topic/ACL과 dual-publish

다른 프로젝트 사전 준비:

- topic/credential 교체가 가능한 설정 구조를 둔다.
- `eventId` 중복 제거와 poison event 격리 전략을 둔다.
- 현재 topic의 메시지를 과거부터 모두 재생해도 안전한 handler를 만든다.

### 단계 3 — Telemetry DB query 전환

예정 변경:

- 전체 메모리 로딩 제거
- keyset cursor pagination
- DB 집계/index/retention

다른 프로젝트 영향:

- admin API를 호출한다면 offset/page 번호에 의존하지 말고 `nextCursor`를 수용할 수 있게 한다.
- telemetry 보존 기간을 업무 데이터 보존 기간으로 오해하지 않는다.

### 단계 4 — 호출 복원력과 health

예정 변경:

- upstream timeout과 정확한 HTTP status 전달
- cache singleflight와 byte budget
- `/health/live`, `/health/ready`
- 실제 Kafka lag/outbox/DLQ metric

다른 프로젝트 영향:

- retry는 멱등 요청에만 적용한다.
- readiness 실패를 사용자 데이터 없음(404)으로 바꾸지 않는다.

### 단계 5 — ImageAsset/ImageVariant 수명주기

예정 변경:

- authoritative `ImageAsset`, `ImageVariant` metadata
- staged upload와 reconciliation
- 원본/variant/cache 통합 delete
- PRE_GENERATE 비동기 job 전환

다른 프로젝트 영향:

- upload 직후 모든 variant가 즉시 준비된다고 가정하지 않는다.
- 향후 `assetId`와 variant status를 저장할 확장 필드를 둔다.
- delete를 즉시 물리 삭제가 아니라 상태 전이로 처리할 수 있게 한다.

### 단계 6 — 선택적 수평 확장

예정 변경:

- 공유 object storage/CDN
- 필요할 때만 분산 cache/lock
- 독립 resize worker scaling

다른 프로젝트 영향:

- 내부 storage 경로나 host filesystem을 참조하지 않는다.
- CDN URL은 영구 identity가 아니라 projection으로 취급한다.

## 9. 현재 보장되지 않는 사항

다른 프로젝트가 임시 코드로 보완하거나 영구 전제로 삼아서는 안 되는 항목이다.

- client service 간 path 격리
- 공유 Kafka topic의 tenant confidentiality
- telemetry의 무손실 전달
- cache replica 간 일관성
- storage replica 간 파일 공유
- 모든 upstream 호출의 timeout/circuit breaker
- top-level health 응답의 실제 dependency readiness
- 원본 삭제 시 모든 variant와 cache의 즉시 삭제
- admin 화면의 이미지 목록이 authoritative asset 원장이라는 보장

## 10. 연동 전 합의해야 할 체크포인트

### 단계 1 시작 전

- client service slug/name/owner
- 환경별 API key 발급 책임자와 secret 보관 위치
- 허용 path pattern
- read/upload/delete 권한
- 최대 파일 크기와 rate limit

### 단계 2 Kafka 전환 전

- 필요한 lifecycle event type
- consumer group 소유자
- client별 topic naming/credential 전달 방식
- DLQ 확인 및 재처리 책임

### 단계 5 asset 전환 전

- 다른 프로젝트의 기존 file reference schema
- `imageKey → assetId` backfill 방식
- pending/failed/deleted 상태의 사용자 노출 규칙
- variant eventual consistency 허용 시간

## 11. 다른 프로젝트에서 먼저 작성할 계약 테스트

1. API key 누락/오류 시 401
2. 단계 1 적용 후 타 tenant path 접근 시 403
3. upload 성공 응답의 `imageKey`, `name`, `eventId` 저장
4. 원본 read와 width/height/format variant read
5. 404와 upstream 5xx 구분
6. 동일 lifecycle `eventId`를 두 번 받아도 업무 처리가 한 번만 실행됨
7. Kafka topic/credential 교체 후 코드 변경 없이 재연결
8. upload 성공 후 업무 DB 저장 실패 시 보상/reconciliation 가능
9. delete 요청 재시도가 멱등
10. file-server readiness 실패 시 호출 차단 또는 명시적 degraded 처리

## 12. 다른 AI에게 전달할 프롬프트

아래 내용을 다른 프로젝트의 AI에게 그대로 전달할 수 있다.

```text
이 프로젝트는 별도 file-server 저장소와 연동해야 한다.
먼저 file-server 저장소의 docs/file-server-integration-handoff.md를 읽어라.

목표:
- file-server HTTP/Kafka 구현 세부사항이 도메인에 새지 않도록 adapter/gateway 경계를 설계한다.
- upload 응답의 imageKey/eventId를 보존하고 lifecycle eventId를 멱등 처리한다.
- 단계 1~5의 예정 변경(tenant policy, client별 Kafka topic, cursor pagination,
  async ImageAsset/ImageVariant lifecycle)을 수용할 수 있어야 한다.

금지:
- frontend에 API key 노출
- 공유 Kafka topic을 영구 계약으로 하드코딩
- 절대 URL만 영구 저장
- 사용자 filename이나 externalImageId를 storage primary key로 사용
- telemetry를 비즈니스 원장으로 사용
- 현재 local filesystem/NodeCache 구조를 영구 인프라로 가정

산출물:
1. 현재 프로젝트에서 필요한 FileReference와 FileServerClient interface
2. 환경변수/secret/Kafka 설정 목록
3. upload/read/delete/event 처리 sequence
4. 실패·재시도·보상·멱등성 설계
5. file-server 단계별 전환 호환 전략
6. 구현 전 작성할 contract/integration test 목록

불명확한 업무 요구만 질문하고, file-server의 현재 취약한 동작을 정상 계약으로 고정하지 마라.
```
