# Lifecycle Consumer Tester

`file.image.lifecycle.v1` Kafka topic을 실제 Client Service처럼 소비해보는 로컬 점검용 NestJS 앱입니다.

storage가 발행하는 lifecycle event를 수신한 뒤 메모리에 저장하고, HTTP API로 상태와 수신 이벤트를 확인합니다.

## 언제 쓰나

- Client Service가 `image.upload.completed` / `image.upload.failed`를 어떻게 소비해야 하는지 확인할 때
- Kafka topic, consumer group, client service filter가 맞는지 점검할 때
- `docs/asyncapi/file-image-lifecycle.asyncapi.yaml` 계약대로 payload가 들어오는지 확인할 때
- 실제 백엔드 서비스에 consumer를 붙이기 전 로컬에서 흐름을 검증할 때

## 이벤트 계약

AsyncAPI 문서:

```txt
docs/asyncapi/file-image-lifecycle.asyncapi.yaml
```

문서를 눈으로 확인하려면 [AsyncAPI Studio](https://studio.asyncapi.com/)에 YAML을 붙여 넣습니다. CLI 검증이 필요하면 아래처럼 실행합니다.

```bash
pnpm dlx @asyncapi/cli validate docs/asyncapi/file-image-lifecycle.asyncapi.yaml
```

런타임 검증 기준:

```txt
@file/telemetry-contracts/lifecycle
```

두 기준이 어긋나지 않도록 `src/asyncapi-contract.spec.ts`에서 핵심 topic/event/schema 상수를 확인합니다.

## 환경변수

예시 파일을 복사합니다.

```bash
cp apps/lifecycle-consumer-tester/.env.local.example apps/lifecycle-consumer-tester/.env.local
```

주요 값:

```env
HOST=127.0.0.1
PORT=3110
KAFKA_CLIENT_BROKERS=localhost:9094
LIFECYCLE_KAFKA_CLIENT_ID=lifecycle-consumer-tester
LIFECYCLE_KAFKA_GROUP_ID=lifecycle-consumer-tester-local
LIFECYCLE_KAFKA_TOPIC=file.image.lifecycle.v1
LIFECYCLE_KAFKA_FROM_BEGINNING=true
LIFECYCLE_CONSUMER_TESTER_MAX_EVENTS=200
CLIENT_SERVICE_SLUG=
KAFKA_LIFECYCLE_EVENT_TYPES=image.upload.completed,image.upload.failed
```

`CLIENT_SERVICE_SLUG` 또는 `CLIENT_SERVICE_ID`를 넣으면 해당 Client Service 이벤트만 메모리에 저장합니다. 비워두면 모든 upload completed/failed lifecycle event를 저장합니다.

## 실행

Kafka topic을 먼저 준비합니다.

```bash
pnpm kafka:topics:dev
```

tester 앱 실행:

```bash
pnpm dev:lc-tester
```

또는 패키지 직접 실행:

```bash
pnpm file:lifecycle-consumer-tester start:dev
```

## 확인 API

Health:

```bash
curl -s http://127.0.0.1:3110/health | python3 -m json.tool
```

Consumer 상태:

```bash
curl -s http://127.0.0.1:3110/consumer/status | python3 -m json.tool
```

수신 이벤트 목록:

```bash
curl -s 'http://127.0.0.1:3110/events?limit=20' | python3 -m json.tool
```

필터 예시:

```bash
curl -s 'http://127.0.0.1:3110/events?clientServiceSlug=local-demo&eventType=image.upload.completed&status=success' \
  | python3 -m json.tool
```

메모리 이벤트 초기화:

```bash
curl -s -X DELETE http://127.0.0.1:3110/events | python3 -m json.tool
```

## 이벤트 발생시키기

전체 앱을 띄운 뒤 `INSPECT.md`의 Client Service 등록과 업로드 절차를 먼저 진행합니다. 성공 이벤트는 같은 업로드를 다시 실행하면 들어옵니다.

실패 이벤트는 인증 실패가 아니라 storage 업로드 처리 중 실패해야 발행됩니다. 예를 들어 이미지가 아닌 파일을 업로드하면 `image.upload.failed`가 들어옵니다.

```bash
printf 'not image' > /tmp/file-server-not-image.txt
STAMP="$(date +%s)"

curl -i -X POST http://127.0.0.1:3032/image \
  -H "x-client-api-key: $CLIENT_API_KEY" \
  -H "x-request-id: inspect-upload-failed-$STAMP" \
  -F path=inspect/image \
  -F 'file=@/tmp/file-server-not-image.txt;type=text/plain;filename=not-image.txt'
```

응답은 `400 Bad Request`가 정상이고, tester에는 `image.upload.failed`가 저장되어야 합니다.

이벤트가 안 들어오면 outbox 상태를 먼저 봅니다.

```bash
psql "$DATABASE_URL" -c "
select event_id, status, attempts, last_error, next_attempt_at, published_at
from image_lifecycle_outbox
order by created_at desc
limit 10;
"
```

`status=PUBLISHED`면 Kafka 발행은 끝난 상태라 tester의 `LIFECYCLE_KAFKA_GROUP_ID`, `CLIENT_SERVICE_SLUG`, `CLIENT_SERVICE_ID`, `LIFECYCLE_KAFKA_FROM_BEGINNING` 값을 봐야 합니다.

## 로그 확인

이 앱은 기존 `storage` / `resize` / `cache`와 같은 `@file/nest-common` request logger를 사용합니다.

- `/health`는 health check 노이즈를 줄이기 위해 request log에서 제외합니다.
- `/consumer/status`, `/events`, `DELETE /events` 요청은 `lifecycle-consumer-tester` context로 로그가 찍힙니다.
- Kafka lifecycle event가 저장되면 아래 형태의 로그가 찍힙니다.

```txt
Lifecycle event stored: eventId=... eventType=image.upload.completed status=success clientService=local-demo imageKey=demo/image/sample.png offset=0:1
```

이 로그가 안 보이면 먼저 아래를 확인하세요.

1. `file.image.lifecycle.v1` topic이 생성됐는지
2. storage 업로드 성공/실패가 실제로 발생했는지
3. `.env.local`의 `CLIENT_SERVICE_SLUG` / `CLIENT_SERVICE_ID` filter가 이벤트 payload와 맞는지
4. 같은 `LIFECYCLE_KAFKA_GROUP_ID`로 이미 offset을 소비한 상태가 아닌지

## 응답 구조

`GET /events`는 최신 수신 이벤트부터 반환합니다.

```json
{
  "count": 1,
  "items": [
    {
      "receivedAt": "2026-07-07T00:00:00.000Z",
      "topic": "file.image.lifecycle.v1",
      "partition": 0,
      "offset": "1",
      "key": "local-demo:demo/image/sample.png:image.upload.completed",
      "event": {
        "schemaVersion": 1,
        "eventId": "...",
        "eventType": "image.upload.completed",
        "sourceApp": "storage",
        "status": "success",
        "imageKey": "demo/image/sample.png"
      }
    }
  ]
}
```

## 테스트

```bash
pnpm file:lifecycle-consumer-tester lint
pnpm file:lifecycle-consumer-tester test
pnpm file:lifecycle-consumer-tester build
```

## 주의

- 이 앱은 로컬 점검용입니다. 수신 이벤트는 DB가 아니라 프로세스 메모리에만 저장됩니다.
- Kafka delivery는 at-least-once 기준이라 같은 `eventId`가 중복 수신될 수 있습니다. 실제 Client Service는 `eventId`로 idempotency 처리를 해야 합니다.
- 이 tester는 Kafka ACL을 강제하지 않습니다. 서비스별 구독/권한 관리는 현재 DB/admin-web에서 운영 기준으로 관리합니다.
