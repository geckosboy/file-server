# File Server

The structure of "Monolithic Repositors" is being used. It is a file service for handling files while maintaining low connectivity with API servers using Kafka.

## Before Start

.yarn: Use "yarn berry"(v4.5.0) to use monorepo

```bash
# install dependencies
$ yarn install

# Kafka container start
$ docker-compose -f ./docker/docker-compose.dev.yml up -d
```

## Running

```bash
# Main server
$ yarn file:storage {command}

# Resizing server
$ yarn file:resize {command}

# Cache server
$ yarn file:cache {command}

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
