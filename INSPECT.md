좋아요. 직접 점검할 때는 아래 순서대로 보면 됩니다.

## 전체 플로우

업로드/삭제:
내 백엔드 → storage → 로컬 파일 저장/삭제 → Kafka 이벤트 발행

원본 조회:
내 백엔드 → storage → 로컬 파일 반환

리사이즈 조회:
내 백엔드 → resize → storage에서 원본 fetch → sharp resize → 반환

캐시 조회:
내 백엔드 → cache
├─ cache hit → 바로 반환
└─ cache miss → resize → storage → 결과 캐싱 → 반환

3단계부터 `storage`, `resize`, `cache`의 `/image` 라우트는 모두 `x-client-api-key`가 필요합니다. API key는 PostgreSQL 서비스 레지스트리에 저장된 key만 통과하고, 세 앱과 `telemetry-api`는 같은 `CLIENT_API_KEY_PEPPER`를 써야 합니다. 요청 ID는 `x-request-id`를 주면 그대로 쓰고, 없으면 guard가 자동 생성해서 telemetry event에 넣습니다.

## 0. PostgreSQL / API key 준비

```bash
docker compose -f docker/docker-compose.postgres.yml up -d

DATABASE_URL="postgresql://file_server:file_server@127.0.0.1:5432/file_server" \
  pnpm db:migrate:deploy
```

`apps/telemetry-api/.env.local`을 만듭니다.

```bash
cat > apps/telemetry-api/.env.local <<'EOF_ENV'
HOST=127.0.0.1
PORT=3100
DATABASE_URL=postgresql://file_server:file_server@127.0.0.1:5432/file_server
TELEMETRY_ADMIN_TOKEN=dev-admin-token
CLIENT_API_KEY_PEPPER=dev-local-pepper
EOF_ENV
```

터미널 하나에서 telemetry-api를 먼저 켭니다.

```bash
set -a
source apps/telemetry-api/.env.local
set +a
pnpm file:telemetry-api start:dev
```

다른 터미널에서 점검용 client service와 API key를 발급합니다.

```bash
STAMP="$(date +%s)"
SERVICE_SLUG="local-demo-$STAMP"
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

echo "SERVICE_ID=$SERVICE_ID"
echo "SERVICE_SLUG=$SERVICE_SLUG"
echo "CLIENT_API_KEY=$CLIENT_API_KEY"
```

`CLIENT_API_KEY` 원문은 최초 1회만 보입니다. 새 터미널에서 curl을 실행한다면 위 값을 다시 export하세요.

## 1. Kafka 실행

```bash
docker compose -f docker/docker-compose.dev.yml --profile ui up -d
```

Kafka UI는 필요하면:

```txt
http://localhost:8080
```

## 2. 앱 3개 각각 실행

터미널 3개를 열고 실행하세요. `DATABASE_URL`과 `CLIENT_API_KEY_PEPPER`는 0단계와 같아야 합니다.

### Storage

```bash
NODE_ENV=development \
PORT=3032 \
ORIGIN_LIST_STR=http://localhost:3000,http://127.0.0.1:3000 \
KAFKA_CLIENT_BROKERS=localhost:9094 \
DATABASE_URL=postgresql://file_server:file_server@127.0.0.1:5432/file_server \
CLIENT_API_KEY_PEPPER=dev-local-pepper \
CACHE_SERVER=http://127.0.0.1:3030 \
pnpm file:storage start:dev
```

### Resize

```bash
NODE_ENV=development \
PORT=3031 \
ORIGIN_LIST_STR=http://localhost:3000,http://127.0.0.1:3000 \
KAFKA_CLIENT_BROKERS=localhost:9094 \
DATABASE_URL=postgresql://file_server:file_server@127.0.0.1:5432/file_server \
CLIENT_API_KEY_PEPPER=dev-local-pepper \
STORAGE_SERVER=http://127.0.0.1:3032 \
pnpm file:resize start:dev
```

### Cache

```bash
NODE_ENV=development \
PORT=3030 \
ORIGIN_LIST_STR=http://localhost:3000,http://127.0.0.1:3000 \
KAFKA_CLIENT_BROKERS=localhost:9094 \
DATABASE_URL=postgresql://file_server:file_server@127.0.0.1:5432/file_server \
CLIENT_API_KEY_PEPPER=dev-local-pepper \
RESIZING_SERVER=http://127.0.0.1:3031 \
pnpm file:cache start:dev
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

핵심 점검 포인트는 storage 직접 조회, resize가 storage를 타는지, cache 두 번째 요청에서 hit가 나는지, Kafka UI의 standard telemetry event에 `clientServiceId`, `clientServiceSlug`, `requestId`가 들어가는지입니다.

---

## 10. telemetry-api / admin-web 점검

주의: 현재 `telemetry-api`는 Kafka topic을 직접 consume하지 않습니다. storage/resize/cache가 Kafka에 발행한 이벤트가 자동으로 들어오는 구조가 아니라, `POST /api/ingestion/events`로 직접 넣은 이벤트를 PostgreSQL에 저장하고 admin API로 조회하는 구조입니다. 테스트 모드(`NODE_ENV=test`)나 `TELEMETRY_STORAGE_DRIVER=memory`를 명시한 경우에만 메모리 저장소를 씁니다.

### 10-0. PostgreSQL 실행 및 Prisma migration

위 0단계에서 이미 실행했다면 이 절은 건너뛰어도 됩니다.

로컬 PostgreSQL을 Docker로 띄웁니다.

```bash
docker compose -f docker/docker-compose.postgres.yml up -d
```

이미 5432 포트를 쓰고 있다면 포트를 바꿔 실행합니다.

```bash
POSTGRES_HOST_PORT=55432 docker compose -f docker/docker-compose.postgres.yml up -d
```

migration 적용:

```bash
DATABASE_URL="postgresql://file_server:file_server@127.0.0.1:5432/file_server" \
pnpm db:migrate:deploy
```

55432 포트를 사용했다면 `DATABASE_URL`도 맞춥니다.

```bash
DATABASE_URL="postgresql://file_server:file_server@127.0.0.1:55432/file_server" \
pnpm db:migrate:deploy
```

### 10-1. telemetry-api 환경 파일 만들기

`apps/telemetry-api/.env.local`을 만듭니다.

```bash
cat > apps/telemetry-api/.env.local <<'EOF_ENV'
HOST=127.0.0.1
PORT=3100
DATABASE_URL=postgresql://file_server:file_server@127.0.0.1:5432/file_server
TELEMETRY_ADMIN_TOKEN=dev-admin-token
CLIENT_API_KEY_PEPPER=dev-local-pepper
EOF_ENV
```

현재 telemetry-api는 `.env.local`을 자동 로드하지 않으므로 실행할 때 `source`로 주입합니다.

```bash
set -a
source apps/telemetry-api/.env.local
set +a
pnpm file:telemetry-api start:dev
```

기동 로그에 아래처럼 나오면 정상입니다.

```txt
Nest on: 127.0.0.1:3100
```

### 10-2. admin-web 환경 파일 만들기

`apps/admin-web/.env.local`을 만듭니다.

```bash
cat > apps/admin-web/.env.local <<'EOF_ENV'
TELEMETRY_API_BASE_URL=http://127.0.0.1:3100/api/admin
TELEMETRY_ADMIN_TOKEN=dev-admin-token
EOF_ENV
```

admin-web 실행:

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

API 연결 실패 시 admin-web은 fixture 데이터로 fallback합니다. 화면에 `텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.`가 보이면 telemetry-api 주소, 포트, token을 다시 확인하세요.

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
	}
}
```

토큰이 없거나 틀리면 `401 Unauthorized`가 정상입니다.

```bash
curl -i http://127.0.0.1:3100/api/admin/health
```

### 10-4. 테스트 이벤트 넣기

대시보드에 실제 데이터가 보이도록 이벤트를 몇 개 넣습니다.

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

### 10-5. admin API 직접 조회

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

### 10-6. admin-web 화면 점검 포인트

- `/dashboard`
  - 총 이벤트 수가 0이 아니어야 합니다.
  - `client service` 필터에서 방금 등록한 서비스가 보여야 합니다.
  - 방금 등록한 서비스를 선택하면 해당 서비스 이벤트 기준으로 KPI가 바뀌어야 합니다.
  - 캐시 hit/miss, resize/upload 차트가 표시되어야 합니다.
  - fixture fallback 경고 문구가 없어야 합니다.
- `/events`
  - `manual-upload-*`, `manual-cache-miss-*`, `manual-resize-*` 이벤트가 보여야 합니다.
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

### 10-7. 자동 테스트 명령

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
```

### 10-8. 자주 헷갈리는 점

- `telemetry-api`는 기본적으로 PostgreSQL 저장소를 사용합니다. DB 없이 잠깐만 확인하려면 `TELEMETRY_STORAGE_DRIVER=memory`를 명시하세요.
- `storage/resize/cache → Kafka` 이벤트에는 client service와 requestId가 들어가지만, 현재 `telemetry-api`로 자동 유입되지는 않습니다.
- admin-web이 API를 못 불러오면 에러로 죽지 않고 fixture를 보여줍니다. 실제 연동 확인 시 fallback 경고 문구가 없는지 꼭 보세요.
- admin API는 `x-admin-token` 헤더가 필요합니다.
- admin-web은 기본 API 주소가 `http://localhost:3001/api/admin`이라, 로컬 telemetry-api 포트 `3100`을 쓰려면 `apps/admin-web/.env.local`의 `TELEMETRY_API_BASE_URL` 설정이 필요합니다.
