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

## Running

```bash
# Main server
$ pnpm file:storage {command}

# Resizing server
$ pnpm file:resize {command}

# Cache server
$ pnpm file:cache {command}

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
