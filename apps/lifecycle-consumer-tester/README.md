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
pnpm dev:lifecycle-consumer-tester
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
