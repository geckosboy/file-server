좋아요. 직접 점검할 때는 아래 순서대로 보면 됩니다.

## 전체 플로우

업로드/삭제:
내 백엔드 → storage → 로컬 파일 저장/삭제 → Kafka 이벤트 발행
├─ `file.image.events.v1` → telemetry-api consumer → PostgreSQL 저장
├─ `file.image.lifecycle.v1` → Client Service consumer가 업로드 완료/실패 후속 처리
└─ `image-topic` → 기존 호환용 legacy consumer

원본 조회:
내 백엔드 → storage → 로컬 파일 반환

리사이즈 조회:
내 백엔드 → resize → storage에서 원본 fetch → sharp resize → 반환

캐시 조회:
내 백엔드 → cache
├─ cache hit → 바로 반환
└─ cache miss → resize → storage → 결과 캐싱 → 반환

3단계부터 `storage`, `resize`, `cache`의 `/image` 라우트는 모두 `x-client-api-key`가 필요합니다. API key는 PostgreSQL 서비스 레지스트리에 저장된 key만 통과하고, 세 앱과 `telemetry-api`는 같은 `CLIENT_API_KEY_PEPPER`를 써야 합니다. 요청 ID는 `x-request-id`를 주면 그대로 쓰고, 없으면 guard가 자동 생성해서 telemetry event에 넣습니다.

4단계부터 `telemetry-api`가 Kafka `file.image.events.v1` topic을 직접 consume해서 Prisma `TelemetryEvent` 모델/DB `telemetry_events` 테이블에 자동 저장합니다. 자동 수집까지 보려면 Kafka를 먼저 켠 뒤 telemetry-api를 시작하세요.

storage 업로드 성공/실패는 Client Service 소비용 Kafka topic `file.image.lifecycle.v1`에도 발행됩니다. Client Service는 이 topic을 자기 consumer group으로 소비해서 이미지 업로드 완료 후속 처리나 실패 알림을 붙일 수 있습니다. 기존 `image-topic`은 호환용으로 계속 발행됩니다.

7단계부터 lifecycle 발행은 storage의 outbox를 거칩니다. 업로드 성공/실패 이벤트는 먼저 PostgreSQL `image_lifecycle_outbox`에 저장되고, Kafka 발행 성공 시 `PUBLISHED`로 표시됩니다. Kafka가 잠깐 죽어 발행에 실패하면 row가 `FAILED`로 남고 `LIFECYCLE_OUTBOX_PUBLISH_INTERVAL_MS` 주기로 재시도합니다. 전달 보장은 at-least-once이며, 같은 이벤트가 중복 발행될 수 있으므로 Client Service consumer는 `eventId`를 idempotency key로 저장/무시해야 합니다.

8단계부터 Client Service별 이미지 리사이징 정책은 `client_service_image_resize_policies`와 `client_service_image_resize_variants`에서 관리합니다. 모드는 `ON_DEMAND` / `PRE_GENERATE`이고 variant는 `width`, `height`, `format`, 활성화 여부를 가집니다. 9단계부터 admin-web `/services`에서 이 정책을 조회/수정하고 pre-generate variant를 추가/수정/삭제할 수 있습니다. 10단계부터 `storage` 업로드 성공 시 해당 Client Service 정책이 `PRE_GENERATE`이면 활성 variant를 즉시 생성하고 `image.resize.completed` / `image.resize.failed` telemetry event를 남깁니다. `ON_DEMAND` 서비스는 기존처럼 업로드만 수행합니다.

DB의 실제 테이블/컬럼 이름은 PostgreSQL 관례대로 snake_case입니다. Prisma 코드에서는 `ClientService`, `TelemetryEvent`처럼 모델 이름을 그대로 쓰지만 DB에는 `client_services`, `client_service_keys`, `client_service_policies`, `telemetry_events`, `telemetry_ingestion_metrics`로 생성됩니다. 이미 이전 migration으로 PascalCase 테이블을 만든 DB라면 `000002_use_snake_case_names`가 데이터를 삭제하지 않고 rename합니다.

## 신규 Client Service 추가 시 재시작 기준

새 서비스를 추가하는 일반 절차는 **telemetry-api admin API로 `client_services` / `client_service_keys` / `client_service_lifecycle_subscriptions`에 등록**하는 것입니다. 이 경우 기존에 떠 있는 앱들을 재시작하지 않아도 됩니다.

| 대상 | 신규 서비스 등록 후 재시작 | 근거 | 재시작이 필요한 경우 |
| --- | --- | --- | --- |
| `storage` | 불필요 | `ClientServiceAuthService.authenticate()`가 요청마다 `client_service_keys.key_prefix`를 DB에서 다시 조회하고 서비스 상태/키 만료/폐기 여부를 검사합니다. 앱 메모리에 service allowlist를 들고 있지 않습니다. | `DATABASE_URL`, `CLIENT_API_KEY_PEPPER`, Kafka broker, 파일 저장 경로, 코드가 바뀐 경우 |
| `resize` | 불필요 | `resize`의 `/image` guard도 같은 `ClientServiceAuthModule`을 사용하고, storage 호출 때 인증된 API key/request id를 그대로 forward합니다. | `STORAGE_SERVER`, `DATABASE_URL`, `CLIENT_API_KEY_PEPPER`, 코드가 바뀐 경우 |
| `cache` | 불필요 | `cache`의 `/image` guard도 같은 DB 조회 기반 인증을 쓰고, miss 시 resize 호출에 인증 header를 forward합니다. | `RESIZING_SERVER`, `DATABASE_URL`, `CLIENT_API_KEY_PEPPER`, 코드가 바뀐 경우 |
| `telemetry-api` | 불필요 | client service/API key/subscription/리사이징 정책 생성·수정은 admin API가 DB에 쓰고, 목록/상세 조회도 매 요청 DB에서 읽습니다. | `.env.local`의 DB/Admin token/Kafka consumer 설정, Prisma schema migration, 코드가 바뀐 경우 |
| `admin-web` | 불필요 | telemetry-api를 `cache: 'no-store'`로 호출하고, server action 후 `/services`를 revalidate합니다. | `TELEMETRY_API_BASE_URL`, `TELEMETRY_ADMIN_TOKEN`, 코드가 바뀐 경우 |
| Kafka | 불필요 | 서비스별 topic을 만들지 않습니다. 모든 서비스가 공통 `file.image.lifecycle.v1` topic을 각자 consumer group으로 소비합니다. | topic 자체를 처음 만들 때, broker 주소/보안 설정/ACL 정책을 바꿀 때 |

즉 **새 Client Service 추가만으로는 DB 등록 + API key 발급 + lifecycle subscription 등록**이면 충분합니다. 단, API key hash 검증에 쓰는 `CLIENT_API_KEY_PEPPER`는 `telemetry-api`, `storage`, `resize`, `cache`에서 반드시 같은 값이어야 하며, 이 값을 바꾸면 기존 key를 다시 발급하거나 앱을 재시작해야 합니다.

## 0. 앱별 env / PostgreSQL 준비

이 repo는 런타임 env를 중앙에서 한 파일로 관리하지 않습니다. 각 앱이 자기 파일을 읽습니다.

```bash
cp .env.example .env
cp apps/storage/.env.local.example apps/storage/.env.local
cp apps/resize/.env.local.example apps/resize/.env.local
cp apps/cache/.env.local.example apps/cache/.env.local
cp apps/telemetry-api/.env.local.example apps/telemetry-api/.env.local
cp apps/admin-web/.env.local.example apps/admin-web/.env.local
```

이미 설치된 PostgreSQL을 쓸 때는 아래 파일들의 `DATABASE_URL`을 같은 값으로 맞춥니다. `P1000 Authentication failed`는 코드 문제가 아니라 URL의 사용자/비밀번호/DB 이름이 실제 DB와 다르다는 뜻입니다.

```txt
.env                                  # Prisma CLI 전용
apps/storage/.env.local
apps/resize/.env.local
apps/cache/.env.local
apps/telemetry-api/.env.local
```

`CLIENT_API_KEY_PEPPER`는 API key hash에 쓰는 서버 쪽 pepper입니다. API key를 발급하는 `telemetry-api`와 API key를 검증하는 `storage`, `resize`, `cache`가 모두 같은 값을 써야 합니다.

repo의 Docker PostgreSQL을 쓴다면 기본값 그대로 실행하면 됩니다.

```bash
docker compose -f docker/docker-compose.postgres.yml up -d
pnpm db:migrate:deploy
```

이미 5432 포트를 쓰고 있으면 포트를 바꿔 띄우고, `.env`와 앱별 `.env.local`의 `DATABASE_URL` 포트도 같이 바꿉니다.

```bash
POSTGRES_HOST_PORT=55432 docker compose -f docker/docker-compose.postgres.yml up -d
```

Kafka를 먼저 켠 뒤 telemetry-api를 시작합니다. telemetry-api는 이제 `apps/telemetry-api/.env.local`을 자동 로드하므로 `source`가 필요 없습니다.

```bash
docker compose -f docker/docker-compose.dev.yml --profile ui up -d
pnpm file:telemetry-api start:dev
```

다른 터미널에서 점검용 client service, API key, lifecycle subscription을 발급합니다. 이 작업은 실행 중인 `storage`/`resize`/`cache`를 재시작하지 않고 바로 반영되는지 확인하는 기준 절차입니다.

```bash
STAMP="$(date +%s)"
SERVICE_SLUG="local-demo-$STAMP"
CONSUMER_GROUP="$SERVICE_SLUG-image-lifecycle"
SERVICE_ID="$(
  curl -s -X POST http://127.0.0.1:3100/api/admin/client-services \
    -H 'content-type: application/json' \
    -H 'x-admin-token: dev-admin-token' \
    -d "{\"slug\":\"$SERVICE_SLUG\",\"name\":\"Local Demo\",\"owner\":\"local\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
)"
CLIENT_API_KEY="$(
  curl -s -X POST "http://127.0.0.1:3100/api/admin/client-services/$SERVICE_ID/keys" \
    -H 'content-type: application/json' \
    -H 'x-admin-token: dev-admin-token' \
    -d '{"name":"local inspect key","scopes":{"image":"read-write"}}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["apiKey"])'
)"
curl -s -X POST "http://127.0.0.1:3100/api/admin/client-services/$SERVICE_ID/lifecycle-subscriptions" \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d "{\"eventType\":\"image.upload.completed\",\"consumerGroup\":\"$CONSUMER_GROUP\",\"description\":\"로컬 점검용 업로드 완료 소비\"}" \
  | python3 -m json.tool
curl -s -X POST "http://127.0.0.1:3100/api/admin/client-services/$SERVICE_ID/lifecycle-subscriptions" \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d "{\"eventType\":\"image.upload.failed\",\"consumerGroup\":\"$CONSUMER_GROUP\",\"description\":\"로컬 점검용 업로드 실패 소비\"}" \
  | python3 -m json.tool

echo "SERVICE_ID=$SERVICE_ID"
echo "SERVICE_SLUG=$SERVICE_SLUG"
echo "CLIENT_API_KEY=$CLIENT_API_KEY"
echo "CONSUMER_GROUP=$CONSUMER_GROUP"
```

`CLIENT_API_KEY` 원문은 최초 1회만 보입니다. 새 터미널에서 curl을 실행한다면 위 값을 다시 export하세요. 이 직후 앱을 재시작하지 않고 5~8단계 요청이 성공하면 DB 등록만으로 접근 권한이 반영된 것입니다.

## 1. Kafka 실행

```bash
docker compose -f docker/docker-compose.dev.yml --profile ui up -d
```

로컬 Compose는 개발 편의를 위해 topic auto-create가 켜져 있지만, 실제 운영과 같은 조건으로 보려면 topic을 명시 생성합니다. 이 스크립트는 `image-topic`, `file.image.events.v1`, `file.image.lifecycle.v1`을 만들고 describe까지 출력합니다.

```bash
pnpm kafka:topics:dev
```

실서버 Kafka Compose는 `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`가 기본값입니다. Kafka broker 3대가 뜬 뒤 서버에서 아래를 먼저 실행해야 storage 발행과 Client Service 소비가 안정적으로 시작됩니다.

```bash
pnpm kafka:topics:prod
```

운영에서 partition/replication 값을 바꾸고 싶으면 env로 덮어씁니다.

```bash
KAFKA_TOPIC_PARTITIONS=12 \
KAFKA_TOPIC_REPLICATION_FACTOR=3 \
KAFKA_TOPIC_MIN_ISR=2 \
pnpm kafka:topics:prod
```

Kafka UI는 필요하면:

```txt
http://localhost:8080
```

## 2. 앱 3개 실행

각 앱은 자기 `.env.local`을 자동으로 읽습니다. Turbo로 실행하면 libs build 캐시를 같이 사용합니다.

한 번에 실행:

```bash
pnpm dev:apps
```

따로 보고 싶으면 터미널 3개에서 실행:

```bash
pnpm dev:storage
pnpm dev:resize
pnpm dev:cache
```

## 3. 헬스체크

```bash
curl http://127.0.0.1:3032/health-check
curl http://127.0.0.1:3031/health-check
curl http://127.0.0.1:3030/health-check
```

셋 다 OK가 나오면 됩니다.

## 4. 샘플 이미지 생성

```bash
pnpm --filter @file/storage exec node -e "require('sharp')({create:{width:80,height:60,channels:3,background:{r:255,g:0,b:0}}}).png().toFile('/tmp/file-server-sample.png')"
```

## 5. 업로드 확인

주의: 업로드할 때 path는 내부 저장 경로라서 `demo/image`처럼 끝이 `/image`여야 합니다.

```bash
curl -i -X POST http://127.0.0.1:3032/image \
  -H "x-client-api-key: $CLIENT_API_KEY" \
  -H "x-request-id: inspect-upload-$STAMP" \
  -F 'id=1' \
  -F 'path=demo/image' \
  -F 'file=@/tmp/file-server-sample.png;type=image/png;filename=sample.png'
```

성공하면 `201 Created`.

서비스 리사이징 정책이 `PRE_GENERATE`이면 업로드 직후 원본과 같은 storage 디렉터리에 사전 생성 파일이 함께 만들어집니다. 파일명은 `<원본이름>__w<width|auto>_h<height|auto>.<format>` 형식입니다. 예를 들어 `sample.png`에 `400x400 webp` variant를 두면 storage 내부에는 `sample__w400_h400.webp`가 생성되고 telemetry에는 원본 `imageKey=demo/image/sample.png`, `eventType=image.resize.completed`, `sourceApp=resize`, `width=400`, `height=400`, `format=webp` 이벤트가 기록되어야 합니다.

## 6. 원본 조회 확인

조회 URL에서는 path가 `demo`입니다.

```bash
curl -f http://127.0.0.1:3032/image/demo/sample.png \
  -H "x-client-api-key: $CLIENT_API_KEY" \
  -H "x-request-id: inspect-storage-read-$STAMP" \
  -o /tmp/storage-original.png
```

## 7. 리사이즈 확인

```bash
curl -f 'http://127.0.0.1:3031/image/demo/sample.png?width=40&height=40' \
  -H "x-client-api-key: $CLIENT_API_KEY" \
  -H "x-request-id: inspect-resize-$STAMP" \
  -o /tmp/resized.png
```

## 8. 캐시 확인

첫 요청은 cache miss, 두 번째 요청은 cache hit 로그가 나와야 합니다.

```bash
curl -f 'http://127.0.0.1:3030/image/demo/sample.png?width=40&height=40' \
  -H "x-client-api-key: $CLIENT_API_KEY" \
  -H "x-request-id: inspect-cache-1-$STAMP" \
  -o /tmp/cached-1.png
curl -f 'http://127.0.0.1:3030/image/demo/sample.png?width=40&height=40' \
  -H "x-client-api-key: $CLIENT_API_KEY" \
  -H "x-request-id: inspect-cache-2-$STAMP" \
  -o /tmp/cached-2.png
```

## 9. 삭제 확인

삭제할 때도 path는 `demo/image`를 씁니다.

```bash
curl -i -X DELETE 'http://127.0.0.1:3032/image?id=1&path=demo/image&beforeName=sample.png' \
  -H "x-client-api-key: $CLIENT_API_KEY" \
  -H "x-request-id: inspect-delete-$STAMP"
```

삭제 후 원본 조회가 404면 정상입니다.

```bash
curl -i http://127.0.0.1:3032/image/demo/sample.png \
  -H "x-client-api-key: $CLIENT_API_KEY" \
  -H "x-request-id: inspect-after-delete-$STAMP"
```

핵심 점검 포인트는 storage 직접 조회, resize가 storage를 타는지, cache 두 번째 요청에서 hit가 나는지, Kafka UI의 standard telemetry event에 `clientServiceId`, `clientServiceSlug`, `requestId`가 들어가는지, 그리고 telemetry-api/admin-web에서 같은 이벤트가 DB 조회되는지입니다.

---

## 10. telemetry-api / admin-web 점검

4단계부터 `telemetry-api`는 Kafka `file.image.events.v1` topic을 직접 consume합니다. storage/resize/cache가 Kafka에 발행한 표준 이벤트는 기존 `IngestionService`를 거쳐 PostgreSQL의 Prisma `TelemetryEvent` 모델, 실제 `telemetry_events` 테이블에 자동 저장됩니다. `POST /api/ingestion/events`는 Kafka 없이 수동으로 이벤트를 넣어보는 보조 점검용으로 계속 사용할 수 있습니다. 테스트 모드(`NODE_ENV=test`)나 `TELEMETRY_STORAGE_DRIVER=memory`를 명시한 경우에만 메모리 저장소를 씁니다.

### 10-0. PostgreSQL 실행 및 Prisma migration

위 0단계에서 만든 `.env`의 `DATABASE_URL` 기준으로 migration을 적용합니다. 앱별 `.env.local`에도 같은 DB URL을 넣어야 런타임 앱이 같은 DB를 봅니다.

```bash
docker compose -f docker/docker-compose.postgres.yml up -d
pnpm db:migrate:deploy
```

이미 설치된 PostgreSQL을 쓰면 Docker는 건너뛰고 `.env` / 앱별 `.env.local`의 `DATABASE_URL`만 본인 DB 계정으로 맞춥니다.

### 10-1. telemetry-api 환경 파일 확인

처음 한 번만 예시 파일을 복사합니다.

```bash
cp apps/telemetry-api/.env.local.example apps/telemetry-api/.env.local
```

`apps/telemetry-api/.env.local`에서 `DATABASE_URL`, `TELEMETRY_ADMIN_TOKEN`, `CLIENT_API_KEY_PEPPER`, `KAFKA_CLIENT_BROKERS`를 확인한 뒤 실행합니다. 별도 `source`는 필요 없습니다.

```bash
pnpm file:telemetry-api start:dev
```

Kafka가 먼저 떠 있으면 consumer 연결 로그와 HTTP 기동 로그가 함께 나오면 정상입니다.

```txt
Kafka telemetry consumer connected: file.image.events.v1 group=file-telemetry-api
Nest on: 127.0.0.1:3100
```

### 10-2. admin-web 환경 파일 확인

처음 한 번만 예시 파일을 복사합니다.

```bash
cp apps/admin-web/.env.local.example apps/admin-web/.env.local
```

`apps/admin-web/.env.local`의 `TELEMETRY_API_BASE_URL`과 `TELEMETRY_ADMIN_TOKEN`을 telemetry-api와 맞춘 뒤 실행합니다. 관리자 토큰은 `NEXT_PUBLIC_`으로 노출하지 않습니다.

```bash
pnpm file:admin-web dev
```

브라우저에서 확인:

```txt
http://127.0.0.1:3000
http://127.0.0.1:3000/dashboard
http://127.0.0.1:3000/events
http://127.0.0.1:3000/images
http://127.0.0.1:3000/services
```

### 10-3. telemetry-api 헬스체크

```bash
curl -s http://127.0.0.1:3100/api/admin/health \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool
```

정상 응답 예시:

```json
{
	"ok": true,
	"service": "telemetry-api",
	"storage": {
		"kind": "postgresql",
		"connected": true
	},
	"kafka": {
		"enabled": true,
		"connected": true,
		"consumerLag": null,
		"topic": "file.image.events.v1",
		"groupId": "file-telemetry-api"
	}
}
```

토큰이 없거나 틀리면 `401 Unauthorized`가 정상입니다.

```bash
curl -i http://127.0.0.1:3100/api/admin/health
```

### 10-4. Kafka 자동 수집 확인

5~8단계에서 업로드/조회/리사이즈/캐시 요청을 수행했다면 이벤트는 Kafka를 거쳐 자동으로 DB에 들어옵니다. 아래 조회에서 `inspect-*` requestId나 방금 등록한 `clientServiceSlug`가 보이면 정상입니다.

```bash
curl -s "http://127.0.0.1:3100/api/admin/events?clientServiceId=$SERVICE_ID&limit=20" \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool
```

이벤트가 없다면 Kafka UI에서 `file.image.events.v1` topic에 메시지가 있는지, telemetry-api 헬스체크의 `kafka.connected`가 `true`인지 확인하세요. Kafka를 telemetry-api보다 나중에 켰다면 telemetry-api를 재시작하세요.

### 10-4-1. Client Service lifecycle 이벤트 소비 확인

`file.image.lifecycle.v1`은 telemetry 저장용이 아니라 Client Service가 후속 업무를 붙이기 위한 topic입니다. 각 Client Service는 자기 consumer group을 사용해야 서로 offset을 빼앗지 않습니다.

발행 유실 방지를 위해 storage는 upload lifecycle 이벤트를 바로 Kafka에만 쓰지 않고 `image_lifecycle_outbox`에 먼저 저장합니다. 점검 중 Kafka를 잠시 내려도 row는 남아 있어야 하며, Kafka를 다시 올리면 scheduled publisher가 같은 `eventId`로 재발행합니다. 이 구조는 유실 방지용 at-least-once 패턴이라 중복 수신이 가능하므로 실제 Client Service는 `eventId`를 처리 완료 테이블이나 cache에 기록해 중복 처리를 막아야 합니다.

먼저 topic을 명시 생성합니다.

```bash
pnpm kafka:topics:dev
```

새 터미널에서 예시 consumer를 켭니다. `CLIENT_SERVICE_SLUG`를 넣으면 해당 서비스 이벤트만 출력합니다. 신규 서비스 점검은 위에서 등록한 `CONSUMER_GROUP`을 그대로 쓰면 됩니다. 과거 메시지까지 다시 보려면 임시 점검용 group을 새로 쓰세요. 현재 단계에서는 DB subscription이 운영 관리 기준이고 실제 Kafka ACL 강제는 아직 붙이지 않았습니다.

```bash
KAFKA_CLIENT_BROKERS=localhost:9094 \
KAFKA_LIFECYCLE_GROUP_ID="$CONSUMER_GROUP" \
CLIENT_SERVICE_SLUG="$SERVICE_SLUG" \
pnpm kafka:lifecycle:consume
```

성공 이벤트는 5단계 업로드를 다시 실행하면 확인할 수 있습니다. consumer에 아래처럼 `image.upload.completed`가 찍히면 정상입니다.

```json
{
	"eventType": "image.upload.completed",
	"status": "success",
	"clientServiceSlug": "local-demo-...",
	"requestId": "inspect-upload-...",
	"imageKey": "inspect/image/file-server-sample.png"
}
```

실패 이벤트는 인증 실패가 아니라 storage 업로드 처리 중 실패해야 발행됩니다. 예를 들어 이미지가 아닌 `text/plain` 파일을 업로드하면 guard는 통과하지만 storage 이미지 처리에서 실패하고 `image.upload.failed` lifecycle 이벤트가 발행됩니다.

```bash
printf 'not image' > /tmp/file-server-not-image.txt
STAMP="$(date +%s)"

curl -i -X POST http://127.0.0.1:3032/image \
  -H "x-client-api-key: $CLIENT_API_KEY" \
  -H "x-request-id: inspect-upload-failed-$STAMP" \
  -F id=999 \
  -F path=inspect/image \
  -F 'file=@/tmp/file-server-not-image.txt;type=text/plain;filename=not-image.txt'
```

응답은 `400 Bad Request`가 정상이고, consumer에 아래처럼 실패 이벤트가 찍혀야 합니다.

```json
{
	"eventType": "image.upload.failed",
	"status": "failed",
	"clientServiceSlug": "local-demo-...",
	"requestId": "inspect-upload-failed-...",
	"imageKey": "inspect/image/not-image.txt",
	"errorCode": "BadRequestException"
}
```

예시 consumer 옵션은 아래에서 볼 수 있습니다.

```bash
pnpm kafka:lifecycle:consume -- --help
```

실제 Client Service 코드에서는 예시처럼 `file.image.lifecycle.v1`을 구독하고, 메시지를 공통 계약 `@file/telemetry-contracts/lifecycle`의 `validateImageLifecycleEvent`로 검증한 뒤 `image.upload.completed` / `image.upload.failed`만 처리하면 됩니다.

### 10-5. 수동 테스트 이벤트 넣기

Kafka 없이 대시보드에 실제 데이터가 보이도록 이벤트를 직접 넣을 수도 있습니다.

먼저 이 이벤트를 어느 서비스가 사용한 것인지 구분할 수 있게 client service를 등록합니다. 위 0단계에서 이미 등록했다면 기존 `SERVICE_ID`, `SERVICE_SLUG`, `CLIENT_API_KEY`를 재사용해도 됩니다.

```bash
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date +%s)"
SERVICE_SLUG="local-demo-$STAMP"
SERVICE_ID="$(
  curl -s -X POST http://127.0.0.1:3100/api/admin/client-services \
    -H 'content-type: application/json' \
    -H 'x-admin-token: dev-admin-token' \
    -d "{\"slug\":\"$SERVICE_SLUG\",\"name\":\"Local Demo\",\"owner\":\"local\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
)"

curl -s -X POST "http://127.0.0.1:3100/api/admin/client-services/$SERVICE_ID/keys" \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d '{"name":"local test key","scopes":{"telemetry":"write"}}' \
  | python3 -m json.tool
```

응답의 `apiKey`는 최초 1회만 보이므로 필요하면 따로 저장하세요. `key.keyHash`는 응답에 노출되지 않는 것이 정상입니다.

```bash
curl -i -X POST http://127.0.0.1:3100/api/ingestion/events \
  -H 'content-type: application/json' \
  -d @- <<EOF_EVENT
{
  "schemaVersion": 1,
  "eventId": "manual-upload-$STAMP",
  "eventType": "image.upload.completed",
  "occurredAt": "$NOW",
  "sourceApp": "storage",
  "environment": "development",
  "clientServiceId": "$SERVICE_ID",
  "clientServiceSlug": "$SERVICE_SLUG",
  "imageId": 1,
  "path": "demo/image",
  "name": "sample.png",
  "imageKey": "demo/image/sample.png",
  "format": "png",
  "inputBytes": 1024,
  "outputBytes": 800,
  "durationMs": 12,
  "status": "success"
}
EOF_EVENT

curl -i -X POST http://127.0.0.1:3100/api/ingestion/events \
  -H 'content-type: application/json' \
  -d @- <<EOF_EVENT
{
  "schemaVersion": 1,
  "eventId": "manual-cache-miss-$STAMP",
  "eventType": "image.cache.miss",
  "occurredAt": "$NOW",
  "sourceApp": "cache",
  "environment": "development",
  "clientServiceId": "$SERVICE_ID",
  "clientServiceSlug": "$SERVICE_SLUG",
  "path": "demo/image",
  "name": "sample.png",
  "imageKey": "demo/image/sample.png",
  "cacheKey": "demo|40|40|sample.png",
  "width": 40,
  "height": 40,
  "format": "png",
  "durationMs": 5,
  "status": "success"
}
EOF_EVENT

curl -i -X POST http://127.0.0.1:3100/api/ingestion/events \
  -H 'content-type: application/json' \
  -d @- <<EOF_EVENT
{
  "schemaVersion": 1,
  "eventId": "manual-resize-$STAMP",
  "eventType": "image.resize.completed",
  "occurredAt": "$NOW",
  "sourceApp": "resize",
  "environment": "development",
  "clientServiceId": "$SERVICE_ID",
  "clientServiceSlug": "$SERVICE_SLUG",
  "path": "demo/image",
  "name": "sample.png",
  "imageKey": "demo/image/sample.png",
  "width": 40,
  "height": 40,
  "format": "png",
  "inputBytes": 800,
  "outputBytes": 300,
  "durationMs": 18,
  "status": "success"
}
EOF_EVENT
```

각 요청이 `202 Accepted`와 함께 아래 형태로 응답하면 수집 성공입니다.

```json
{
	"accepted": true,
	"inserted": true,
	"eventId": "manual-upload-..."
}
```

같은 `eventId`를 다시 넣으면 `inserted: false`가 나올 수 있는데, 중복 방지 동작이라 정상입니다.

### 10-6. admin API 직접 조회

요약:

```bash
curl -s 'http://127.0.0.1:3100/api/admin/dashboard/summary' \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool
```

시계열:

```bash
curl -s 'http://127.0.0.1:3100/api/admin/dashboard/timeseries?interval=hour' \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool
```

이벤트 목록:

```bash
curl -s 'http://127.0.0.1:3100/api/admin/events?limit=10' \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool

curl -s "http://127.0.0.1:3100/api/admin/events?clientServiceId=$SERVICE_ID&limit=10" \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool
```

서비스 레지스트리:

```bash
curl -s 'http://127.0.0.1:3100/api/admin/client-services' \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool

curl -s "http://127.0.0.1:3100/api/admin/client-services/$SERVICE_ID" \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool
```

이미지 집계:

```bash
curl -s 'http://127.0.0.1:3100/api/admin/images?limit=10&sort=reads&order=desc' \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool
```

특정 이미지 상세는 `/`를 URL 인코딩해서 조회합니다.

```bash
curl -s 'http://127.0.0.1:3100/api/admin/images/demo%2Fimage%2Fsample.png' \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool

curl -s 'http://127.0.0.1:3100/api/admin/images/demo%2Fimage%2Fsample.png/events?limit=10' \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool

curl -s 'http://127.0.0.1:3100/api/admin/images/demo%2Fimage%2Fsample.png/variants' \
  -H 'x-admin-token: dev-admin-token' \
  | python3 -m json.tool
```

### 10-7. admin-web 화면 점검 포인트

- `/dashboard`
  - 총 이벤트 수가 0이 아니어야 합니다.
  - `client service` 필터에서 방금 등록한 서비스가 보여야 합니다.
  - 방금 등록한 서비스를 선택하면 해당 서비스 이벤트 기준으로 KPI가 바뀌어야 합니다.
  - 캐시 hit/miss, resize/upload 차트가 표시되어야 합니다.
  - fixture fallback 경고 문구가 없어야 합니다.
- `/events`
  - 자동 수집을 봤다면 `inspect-*`, 수동 이벤트를 넣었다면 `manual-*` 이벤트가 보여야 합니다.
  - source app이 각각 `storage`, `cache`, `resize`로 보여야 합니다.
  - service 컬럼에 등록한 `clientServiceSlug`가 보여야 합니다.
  - `client service` 필터로 서비스별 이벤트를 좁힐 수 있어야 합니다.
- `/images`
  - `demo/image/sample.png`가 목록에 보여야 합니다.
  - 요청 수, 리사이즈 수, cache miss 수가 API 응답과 맞아야 합니다.
  - `client service` 필터로 서비스별 이미지 집계를 좁힐 수 있어야 합니다.
- `/services`
  - 서비스 등록/수정 폼이 보여야 합니다.
  - API key 발급 시 key 원문이 화면에 1회 표시되어야 합니다.
  - 발급된 key 목록에는 prefix만 보이고 hash나 원문은 노출되지 않아야 합니다.
  - key 폐기 버튼으로 key 상태를 폐기 처리할 수 있어야 합니다.
  - 리사이징 정책 영역에서 `ON_DEMAND` / `PRE_GENERATE` 모드를 저장할 수 있어야 합니다.
  - pre-generate variant의 width/height/format/활성화 여부/설명을 추가·수정·삭제할 수 있어야 합니다.
  - `PRE_GENERATE` 서비스로 업로드한 뒤 `/events`에서 같은 원본 `imageKey`의 `image.resize.completed` 또는 `image.resize.failed` 이벤트가 보여야 합니다.

### 10-8. 자동 테스트 명령

```bash
pnpm file:telemetry-api test
pnpm file:telemetry-api lint
pnpm file:admin-web test
pnpm file:admin-web lint
pnpm file:admin-web typecheck
```

전체 확인:

```bash
pnpm all:build
pnpm all:lint
pnpm all:test
pnpm all:test:e2e
```

### 10-9. 자주 헷갈리는 점

- `telemetry-api`는 기본적으로 PostgreSQL 저장소를 사용합니다. DB 없이 잠깐만 확인하려면 `TELEMETRY_STORAGE_DRIVER=memory`를 명시하세요.
- `storage/resize/cache → Kafka` 이벤트가 DB에 안 보이면 `telemetry-api`를 Kafka보다 먼저 켠 상태일 수 있습니다. Kafka를 켠 뒤 telemetry-api를 재시작하세요.
- upload lifecycle 이벤트가 consumer에 안 보이면 먼저 PostgreSQL의 `image_lifecycle_outbox`에서 해당 `event_id` row의 `status`, `attempts`, `last_error`, `next_attempt_at`을 확인하세요. `FAILED`면 Kafka 복구 후 storage outbox publisher가 재시도합니다.
- admin-web이 API를 못 불러오면 에러로 죽지 않고 fixture를 보여줍니다. 실제 연동 확인 시 fallback 경고 문구가 없는지 꼭 보세요.
- admin API는 `x-admin-token` 헤더가 필요합니다.
- admin-web은 기본 API 주소가 `http://localhost:3001/api/admin`이라, 로컬 telemetry-api 포트 `3100`을 쓰려면 `apps/admin-web/.env.local`의 `TELEMETRY_API_BASE_URL` 설정이 필요합니다.
