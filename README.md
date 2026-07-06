# File Server

The structure of "Monolithic Repositors" is being used. It is a file service for handling files while maintaining low connectivity with API servers using Kafka.

## Before Start

pnpm: Use pnpm workspaces to manage the monorepo

```bash
# install dependencies
$ pnpm install

# Kafka 4.x KRaft container start
$ docker compose -f ./docker/docker-compose.dev.yml up -d

# Kafka UI까지 같이 실행할 때
$ docker compose -f ./docker/docker-compose.dev.yml --profile ui up -d

# 실서버 옵션을 파일로 분리해서 실행할 때
$ cp docker/kafka.env.example docker/kafka.env
$ docker compose --env-file docker/kafka.env -f ./docker/docker-compose.dev.yml up -d
```

## Kafka Runtime

현재 Kafka compose는 Apache Kafka `4.3.1` 공식 이미지와 KRaft 모드를 사용합니다. ZooKeeper는 더 이상 띄우지 않습니다.

- `docker/kafka.env.example`의 `KAFKA_VERSION`, `KAFKA_EXTERNAL_*` 값은 Kafka 컨테이너 실행용입니다.
- `KAFKA_CLIENT_BROKERS`는 Kafka 컨테이너가 아니라 storage/resize/cache 앱이 읽는 접속값입니다.
- 로컬에서 앱을 직접 실행하면 `KAFKA_CLIENT_BROKERS=localhost:9094`를 사용하세요.
- 같은 Docker 네트워크의 앱 컨테이너가 붙으면 `KAFKA_CLIENT_BROKERS=kafka:9092`를 사용하세요.
- 실서버에서는 `docker/kafka.env.example`을 복사한 뒤 `KAFKA_EXTERNAL_ADVERTISED_HOST`를 실제 DNS/IP로 바꾸고, 앱 env에는 `KAFKA_CLIENT_BROKERS=실서버_DNS_또는_IP:9094`를 넣으세요.
- `KAFKA_CLUSTER_ID`는 Kafka volume과 묶이는 값이라, 운영 시작 후에는 바꾸지 마세요.
- 현재 compose는 단일 브로커 기준입니다. 3브로커 이상으로 확장할 때는 replication factor와 min ISR 값을 같이 올려야 합니다.
- 이미 `kafka`/`kafka-ui` 이름이나 `9092`/`9094` 포트를 쓰는 컨테이너가 있으면 `KAFKA_CONTAINER_NAME`, `KAFKA_UI_CONTAINER_NAME`, `KAFKA_INTERNAL_HOST_PORT`, `KAFKA_EXTERNAL_HOST_PORT`, `KAFKA_EXTERNAL_ADVERTISED_PORT`를 같이 바꿔서 띄우세요.

### Production Kafka Compose

실서버 Kafka만 분리해서 띄울 때는 루트의 `docker/docker-compose.kafka.yml`을 사용합니다. 이 파일은 Kafka 4.x KRaft isolated mode 기준으로 broker 3대와 controller quorum 3대를 띄웁니다.

```bash
# Kafka만 실행
$ docker compose -f docker/docker-compose.kafka.yml up -d

# Kafka UI까지 같이 실행
$ docker compose -f docker/docker-compose.kafka.yml --profile ui up -d
```

단일 서버에서 이 compose를 쓰면 앱 env는 보통 아래처럼 둡니다.

```env
# 앱도 같은 Docker 네트워크에 붙는 경우
KAFKA_CLIENT_BROKERS=kafka-broker-1:9092,kafka-broker-2:9092,kafka-broker-3:9092

# 앱이 호스트 프로세스나 외부 서버에서 붙는 경우
KAFKA_CLIENT_BROKERS=실서버_DNS_또는_IP:19092,실서버_DNS_또는_IP:19093,실서버_DNS_또는_IP:19094
```

운영용 compose는 `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`가 기본값이므로 topic을 먼저 만들어야 합니다. 아래 스크립트는 telemetry 저장용 `file.image.events.v1`, Client Service lifecycle 소비용 `file.image.lifecycle.v1`을 생성하고 describe까지 출력합니다. 더 이상 legacy `image-topic`은 생성하지 않습니다.

```bash
# 로컬 단일 브로커 compose
$ pnpm kafka:topics:dev

# 실서버 3 broker compose
$ pnpm kafka:topics:prod
```

운영 partition/replication 값을 조정하려면 env로 덮어씁니다.

```bash
$ KAFKA_TOPIC_PARTITIONS=12 \
  KAFKA_TOPIC_REPLICATION_FACTOR=3 \
  KAFKA_TOPIC_MIN_ISR=2 \
  pnpm kafka:topics:prod
```

주의: 이 compose는 한 서버 안에 6개 Kafka 프로세스를 띄우는 형태라 프로세스 장애와 롤링 재시작에는 유리하지만, 서버 자체 장애까지 버티려면 controller/broker를 여러 서버로 나눠야 합니다.

Client Service가 업로드 성공/실패 이벤트를 소비해 보려면 예시 consumer를 실행합니다.

```bash
$ KAFKA_CLIENT_BROKERS=localhost:9094 \
  KAFKA_LIFECYCLE_GROUP_ID=my-service-image-lifecycle-local \
  CLIENT_SERVICE_SLUG=local-demo \
  pnpm kafka:lifecycle:consume
```

이 consumer는 `file.image.lifecycle.v1`에서 `image.upload.completed` / `image.upload.failed` 이벤트를 읽고 `@file/telemetry-contracts/lifecycle` 계약으로 payload를 검증합니다. storage는 lifecycle 이벤트를 PostgreSQL `image_lifecycle_outbox`에 먼저 저장한 뒤 Kafka로 발행하므로, consumer는 at-least-once 중복에 대비해 `eventId`를 idempotency key로 사용하세요.

## Environment files

Runtime apps do not share one central root env file. Each app reads its own local env file:

```bash
cp apps/storage/.env.local.example apps/storage/.env.local
cp apps/resize/.env.local.example apps/resize/.env.local
cp apps/cache/.env.local.example apps/cache/.env.local
cp apps/telemetry-api/.env.local.example apps/telemetry-api/.env.local
cp apps/admin-web/.env.local.example apps/admin-web/.env.local
```

Root `.env` is for Prisma CLI commands only. Keep `DATABASE_URL` identical in root `.env` and every backend app env that talks to PostgreSQL. Keep `CLIENT_API_KEY_PEPPER` identical in `telemetry-api`, `storage`, `resize`, and `cache`; it is used to hash and verify client service API keys.

## Running

```bash
# Main server
$ pnpm file:storage {command}

# Resizing server
$ pnpm file:resize {command}

# Cache server
$ pnpm file:cache {command}

# Run storage/resize/cache through Turborepo
$ pnpm dev:apps

# Docker Dev Server
$ docker compose -f docker/apps/docker-compose.dev.yml up -d
```

## Local/Internal Access

By default, each Nest app binds to `127.0.0.1` when `HOST` is not set.
Use `HOST=0.0.0.0` only for Docker/internal network scenarios where your own backend service must reach the container.
Keep upload/delete endpoints behind that backend or an internal network boundary. Set `INTERNAL_API_KEY` on storage and send `x-internal-api-key` from your backend when you want an extra local-only write guard.

## Features

- Upload/Delete/Get Image
- Resizing Image
- Caching Image
- To be added,,,

## TODO

### Image

- [x] Upload, Get, Delete -> app folder
- [x] Caching -> cache folder
- [x] Resizing -> resize folder

### Video

- [ ] Upload, Get, Delete
- [ ] Caching
- [ ] Resizing
- [ ] Streaming(Not sure)

### ETC

- [ ] If there is any additional service you want to implement, please write it in the Issue tab.

## Document

Please refer to the Notion link below for explanations such as architecture and trial and error.(Language: 한국어)

Notion: <https://stormy-lighter-fb5.notion.site/File-Server-a01136fb954b4a8180b33ed483e61a2d?pvs=4>
