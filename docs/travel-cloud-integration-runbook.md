# Travel Cloud Docker Integration Runbook

## 목적

이 하네스는 Travel Cloud가 file-server와 연동하기 전에 다음 경계를 실제 프로세스로 검증한다.

- PostgreSQL migration과 authoritative image metadata
- Kafka `StandardAuthorizer`, deny-by-default ACL, SCRAM-SHA-512 client credential
- storage/cache/resize/telemetry-api 컨테이너
- Nginx reverse proxy를 통과하는 upload/read/delete
- Travel Cloud 전용 Client Service, API key, namespace policy
- lifecycle subscription `PROVISIONED`
- 전용 topic/consumer group consume와 타 topic/group/produce 거부
- 종료 후 container/network/volume/runtime secret cleanup

HTTP나 Kafka를 mock하지 않는다. 로컬 하네스는 단일 Kafka broker와 `SASL_PLAINTEXT`를 사용하지만 principal, SCRAM 인증, topic/group ACL과 deny-by-default authorizer 의미는 운영과 같다. 운영의 3 broker replication 및 `SASL_SSL`/CA 검증은 별도 배포 gate다.

## 구성

```text
Travel Cloud backend
        │
        ├── HTTP ──> Nginx :18088
        │              ├── POST/DELETE /file-server/images ──> storage
        │              └── GET /file-server/images/* ───────> cache
        │                                                       └── resize ──> storage
        │
        └── Kafka :39094 ──> Travel Cloud 전용 lifecycle topic

telemetry-api ──> Client Service/API key/policy/subscription 관리
storage/cache/resize/telemetry-api ──> PostgreSQL + Kafka
```

Nginx는 선택 구성요소가 아니다. 이 Travel Cloud 통합 환경에서는 유일한 외부 HTTP 진입점이다. storage/resize GET은 호스트에 publish하지 않고, read는 반드시 cache를 거친다. telemetry-api의 localhost 포트는 하네스 프로비저닝용 control plane이다.

## 사전 조건

- Node.js 22 계열
- pnpm 10 계열
- Docker Desktop 또는 Docker Engine + Compose plugin
- 기본 권장 여유 메모리 6GB 이상
- 기본 포트 `18088`, `13100`, `39094`가 비어 있어야 함

포트가 충돌하면 실행 전에 덮어쓴다.

```bash
export TRAVEL_CLOUD_PROXY_HOST_PORT=28088
export TRAVEL_CLOUD_TELEMETRY_HOST_PORT=23100
export TRAVEL_CLOUD_KAFKA_HOST_PORT=49094
```

PostgreSQL은 하네스 네트워크 안에서만 접근하며 호스트 포트를 사용하지 않는다.

모든 입력 변수 예시는 [`docker/travel-cloud/harness.env.example`](../docker/travel-cloud/harness.env.example)에 있다.

```bash
set -a
source docker/travel-cloud/harness.env.example
set +a
```

### 하네스 입력 환경변수 전체 목록

| 변수                                 | 기본값                       | 의미                                                                | 변경 시 주의사항                                            |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `TRAVEL_CLOUD_INTEGRATION_PROJECT`   | `file-server-travel-cloud`   | Compose project 이름이자 cleanup 대상 resource label                | 다른 하네스와 동시에 실행할 때만 고유 이름 사용             |
| `TRAVEL_CLOUD_PROXY_HOST_PORT`       | `18088`                      | 호스트에 publish하는 Nginx 포트                                     | 포트 충돌 시 변경                                           |
| `TRAVEL_CLOUD_PROXY_ADVERTISED_HOST` | `127.0.0.1`                  | 생성 env의 HTTP base URL에 기록할 hostname                          | Travel Cloud가 별도 컨테이너면 `host.docker.internal`       |
| `TRAVEL_CLOUD_TELEMETRY_HOST_PORT`   | `13100`                      | 프로비저닝 스크립트가 접근하는 telemetry-api localhost 포트         | public 서비스 포트가 아니며 외부 노출 금지                  |
| `TRAVEL_CLOUD_KAFKA_HOST_PORT`       | `39094`                      | Kafka external listener의 호스트 publish 포트                       | 포트 변경 시 advertised endpoint도 같은 값 사용됨           |
| `TRAVEL_CLOUD_KAFKA_ADVERTISED_HOST` | `localhost`                  | Kafka metadata가 Travel Cloud consumer에게 돌려주는 broker hostname | 별도 컨테이너면 `host.docker.internal`과 `extra_hosts` 필요 |
| `TRAVEL_CLOUD_KAFKA_CLUSTER_ID`      | `VHJhdmVsQ2xvdWRGaWxlU2Vydg` | disposable KRaft cluster ID                                         | Kafka data를 유지한 채 변경 금지                            |
| `POSTGRES_VERSION`                   | `18-alpine`                  | PostgreSQL Docker image tag                                         | 의도적인 DB 버전 검증 때만 변경                             |
| `KAFKA_VERSION`                      | `4.3.1`                      | Apache Kafka Docker image tag                                       | broker/client 호환성 검증 후 변경                           |
| `NGINX_VERSION`                      | `alpine`                     | Nginx Docker image tag                                              | 의도적인 proxy image upgrade 때만 변경                      |

## 1. 전체 환경 실행

```bash
pnpm install --frozen-lockfile
pnpm integration:travel-cloud:up
```

다음 컨테이너가 실행된다.

- `postgres`
- `kafka`
- `kafka-topics` 일회성 bootstrap
- `database-migrate` 일회성 migration
- `storage`
- `resize`
- `cache`
- `telemetry-api`
- `nginx`

상태와 로그:

```bash
pnpm integration:travel-cloud:status
pnpm integration:travel-cloud:logs
```

## 2. Travel Cloud 계약 프로비저닝

```bash
pnpm integration:travel-cloud:provision
```

이 명령은 재실행 가능하며 다음을 수행한다.

1. slug `travel-cloud` Client Service 생성 또는 재사용
2. `travel-cloud/image` namespace read/upload/delete policy 생성
3. scope가 같은 API key 발급
4. client service ID로 계산한 전용 topic 생성
5. SCRAM-SHA-512 credential 생성
6. 전용 topic `READ/DESCRIBE`, 정확한 consumer group `READ` ACL 생성
7. upload/delete completed/failed subscription 네 개 생성
8. 모든 subscription의 `PROVISIONED` 상태 확인

생성 결과는 다음 파일에 mode `0600`으로 저장된다.

```text
.tmp/travel-cloud-integration/travel-cloud.env
.tmp/travel-cloud-integration/runtime.json
```

생성되는 파일에는 아래 설명이 `#` 주석으로 함께 기록된다.

### Travel Cloud에 전달되는 환경변수 전체 목록

| 변수                                   | 의미                                                                                | 보안/사용 규칙                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `TRAVEL_FILE_SERVER_BASE_URL`          | Nginx 외부 base URL. `/images`를 붙여 upload/delete, `/images/:path/:name`으로 read | backend adapter에서만 사용                                                  |
| `TRAVEL_FILE_SERVER_API_KEY`           | Travel Cloud Client Service 인증 key                                                | secret. 브라우저·로그·Kafka payload에 노출 금지                             |
| `TRAVEL_FILE_SERVER_NAMESPACE`         | 허용된 canonical storage namespace. 기본 `travel-cloud/image`                       | upload multipart `path`에 그대로 사용. read에서는 마지막 `/image` 제외      |
| `TRAVEL_FILE_SERVER_CLIENT_SERVICE_ID` | 서버가 발급한 Client Service primary key                                            | topic 이름을 직접 계산하는 용도로 사용하지 말고 event ownership 확인에 사용 |
| `TRAVEL_KAFKA_BROKERS`                 | Travel Cloud에서 접근 가능한 bootstrap broker 목록                                  | 쉼표 구분. KafkaJS 등 client의 `brokers`로 전달                             |
| `TRAVEL_KAFKA_SECURITY_PROTOCOL`       | 로컬 Kafka transport. 현재 `SASL_PLAINTEXT`                                         | 운영에서는 `SASL_SSL`로 교체                                                |
| `TRAVEL_KAFKA_SASL_MECHANISM`          | Kafka 인증 방식. 현재 `SCRAM-SHA-512`                                               | client 설정의 SASL mechanism과 동일해야 함                                  |
| `TRAVEL_KAFKA_USERNAME`                | SCRAM username이며 Kafka principal은 `User:<username>`                              | secret은 아니지만 tenant identity이므로 임의 변경 금지                      |
| `TRAVEL_KAFKA_PASSWORD`                | 동적으로 발급한 SCRAM password                                                      | secret. 로그·commit 금지                                                    |
| `TRAVEL_KAFKA_TOPIC`                   | Travel Cloud가 소비할 유일한 lifecycle topic                                        | canonical/타 client topic으로 대체 금지                                     |
| `TRAVEL_KAFKA_CONSUMER_GROUP`          | ACL이 허용한 유일한 consumer group                                                  | 업무 처리 성공 뒤 offset commit. 다른 group 사용 시 authorization 실패      |

생성 예시:

```env
TRAVEL_FILE_SERVER_BASE_URL=http://127.0.0.1:18088/file-server
TRAVEL_FILE_SERVER_API_KEY=<one-time-issued-secret>
TRAVEL_FILE_SERVER_NAMESPACE=travel-cloud/image
TRAVEL_FILE_SERVER_CLIENT_SERVICE_ID=<server-issued-id>
TRAVEL_KAFKA_BROKERS=localhost:39094
TRAVEL_KAFKA_SECURITY_PROTOCOL=SASL_PLAINTEXT
TRAVEL_KAFKA_SASL_MECHANISM=SCRAM-SHA-512
TRAVEL_KAFKA_USERNAME=file-lifecycle-<client-service-id>
TRAVEL_KAFKA_PASSWORD=<generated-secret>
TRAVEL_KAFKA_TOPIC=file.image.lifecycle.client.<client-service-id>.v1
TRAVEL_KAFKA_CONSUMER_GROUP=travel-cloud-file-lifecycle-v1
```

이 파일은 commit하지 않는다. `integration:travel-cloud:down`이 파일과 DB volume을 제거하므로 필요한 동안에만 secret로 취급한다.

## 3. 기본 HTTP/Kafka smoke

```bash
pnpm integration:travel-cloud:test
```

검증 내용:

- multipart의 `path`를 `file`보다 먼저 전송
- stable `Idempotency-Key` 재시도가 같은 `assetId/imageKey/eventId`로 수렴
- Nginx write route를 통한 upload/delete
- Nginx read route를 통한 cache read 두 번
- `X-File-Server-Proxy: nginx-travel-cloud` 확인
- 외부 Kafka listener에서 SCRAM consumer로 upload/delete lifecycle 수신
- canonical lifecycle topic 거부
- 다른 client topic 거부
- 미등록 consumer group 거부
- client principal의 produce 거부
- delete 후 read 404

이 smoke consumer는 Travel Cloud의 정확한 consumer group을 사용한다. Travel Cloud 애플리케이션 consumer와 동시에 실행하지 않는다.

## 4. Travel Cloud 애플리케이션에서 사용

호스트 프로세스로 Travel Cloud를 실행할 때:

```bash
set -a
source .tmp/travel-cloud-integration/travel-cloud.env
set +a

# Travel Cloud 자체 upload/read/delete/Kafka 테스트 실행
```

Travel Cloud도 Docker 컨테이너라면 macOS/Windows에서 다음처럼 실행한다.

```bash
export TRAVEL_CLOUD_PROXY_ADVERTISED_HOST=host.docker.internal
export TRAVEL_CLOUD_KAFKA_ADVERTISED_HOST=host.docker.internal
pnpm integration:travel-cloud:up
pnpm integration:travel-cloud:provision
```

Linux의 별도 Compose에서 `host.docker.internal`을 사용할 때 Travel Cloud service에 다음을 추가한다.

```yaml
extra_hosts:
  - 'host.docker.internal:host-gateway'
```

다른 프로젝트는 생성된 topic/principal을 다시 계산하지 않고 env 결과를 그대로 주입한다. lifecycle consumer는 `eventId`를 멱등성 key로 저장하고 성공적인 업무 처리 뒤 offset을 commit한다.

## 5. Nginx 계약

| 외부 요청                                 | 내부 대상                      | 비고                                          |
| ----------------------------------------- | ------------------------------ | --------------------------------------------- |
| `POST /file-server/images`                | `storage:3032/image`           | multipart path-before-file, `Idempotency-Key` |
| `DELETE /file-server/images?imageKey=...` | `storage:3032/image`           | 멱등 delete                                   |
| `GET /file-server/images/:path/:name`     | `cache:3030/image/:path/:name` | 외부 read 유일 진입점                         |

Nginx는 다음을 보존한다.

- `x-client-api-key` 또는 `Authorization`
- `Idempotency-Key`
- `x-request-id`, `x-trace-id`
- query string과 upstream HTTP status
- multipart body field order

`proxy_intercept_errors off`, `proxy_request_buffering off`, `proxy_buffering off`를 사용한다. Nginx 자체 response cache는 사용하지 않는다. 업로드 상한은 22MB이고 file-server 기본 20MB보다 약간 크다.

## 6. 한 번에 검증하고 정리

```bash
pnpm integration:travel-cloud:verify
```

순서:

```text
기존 전용 하네스 cleanup
→ build/up
→ migration/topic bootstrap
→ Travel Cloud provisioning
→ HTTP/Kafka smoke
→ container/network/volume/runtime secret cleanup
```

실패하더라도 전용 프로젝트 resource 정리를 시도한다. 다른 Compose project의 컨테이너나 volume은 제거하지 않는다.

## 7. 수동 종료

```bash
pnpm integration:travel-cloud:down
```

다음을 확인한다.

- `file-server-travel-cloud` label의 실행/정지 컨테이너 없음
- 같은 project label의 volume 없음
- 같은 project label의 network 없음
- `.tmp/travel-cloud-integration` 없음

## 운영 전환 시 변경할 것

로컬 하네스 값을 운영 secret으로 복사하지 않는다.

- Kafka를 3 broker/replication 3/min ISR 2 이상으로 배포
- 외부 listener를 `SASL_SSL`로 변경하고 CA 검증
- file-server runtime admin principal을 역할별 최소 권한 principal로 분리
- Nginx TLS, access control, body/timeout 정책을 운영 ingress에 반영
- telemetry-api control plane을 public Nginx route와 분리
- API key와 SCRAM password를 운영 secret manager에서 재발급
- readiness 실패를 image 404로 변환하지 않음
