좋아요. 직접 점검할 때는 아래 순서대로 보면 됩니다.

## 전체 플로우

업로드/삭제:
내 백엔드 → storage → 로컬 파일 저장/삭제 → Kafka 이벤트 발행

원본 조회:
사용자/백엔드 → storage → 로컬 파일 반환

리사이즈 조회:
사용자/백엔드 → resize → storage에서 원본 fetch → sharp resize → 반환

캐시 조회:
사용자/백엔드 → cache
  ├─ cache hit  → 바로 반환
  └─ cache miss → resize → storage → 결과 캐싱 → 반환

## 1. Kafka 실행

docker compose -f docker/docker-compose.dev.yml --profile ui up -d

Kafka UI는 필요하면:

http://localhost:8080

## 2. 앱 3개 각각 실행

터미널 3개를 열고 실행하세요.

### Storage

NODE_ENV=development \
PORT=3032 \
ORIGIN_LIST_STR=http://localhost:3000,http://127.0.0.1:3000 \
KAFKA_CLIENT_BROKERS=localhost:9094 \
INTERNAL_API_KEY=dev-key \
pnpm file:storage start:dev

### Resize

NODE_ENV=development \
PORT=3031 \
ORIGIN_LIST_STR=http://localhost:3000,http://127.0.0.1:3000 \
KAFKA_CLIENT_BROKERS=localhost:9094 \
STORAGE_SERVER=http://127.0.0.1:3032 \
pnpm file:resize start:dev

### Cache

NODE_ENV=development \
PORT=3030 \
ORIGIN_LIST_STR=http://localhost:3000,http://127.0.0.1:3000 \
KAFKA_CLIENT_BROKERS=localhost:9094 \
RESIZING_SERVER=http://127.0.0.1:3031 \
pnpm file:cache start:dev

## 3. 헬스체크

curl http://127.0.0.1:3032/health-check
curl http://127.0.0.1:3031/health-check
curl http://127.0.0.1:3030/health-check

셋 다 OK가 나오면 됩니다.

## 4. 샘플 이미지 생성

pnpm --filter @file/storage exec node -e "require('sharp')({create:{width:80,height:60,channels:3,background:{r:255,g:0,b:0}}}).png().toFile('/tmp/file-server-
sample.png')"

## 5. 업로드 확인

주의: 업로드할 때 path는 내부 저장 경로라서 demo/image처럼 끝이 /image여야 합니다.

curl -i -X POST http://127.0.0.1:3032/image \
  -H 'x-internal-api-key: dev-key' \
  -F 'id=1' \
  -F 'path=demo/image' \
  -F 'file=@/tmp/file-server-sample.png;type=image/png;filename=sample.png'

성공하면 201 Created.

## 6. 원본 조회 확인

조회 URL에서는 path가 demo입니다.

curl -f http://127.0.0.1:3032/image/demo/sample.png -o /tmp/storage-original.png

## 7. 리사이즈 확인

curl -f 'http://127.0.0.1:3031/image/demo/sample.png?width=40&height=40' -o /tmp/resized.png

## 8. 캐시 확인

첫 요청은 cache miss, 두 번째 요청은 cache hit 로그가 나와야 합니다.

curl -f 'http://127.0.0.1:3030/image/demo/sample.png?width=40&height=40' -o /tmp/cached-1.png
curl -f 'http://127.0.0.1:3030/image/demo/sample.png?width=40&height=40' -o /tmp/cached-2.png

## 9. 삭제 확인

삭제할 때도 path=demo/image를 씁니다.

curl -i -X DELETE 'http://127.0.0.1:3032/image?id=1&path=demo/image&beforeName=sample.png' \
  -H 'x-internal-api-key: dev-key'

삭제 후 원본 조회가 404면 정상입니다.

curl -i http://127.0.0.1:3032/image/demo/sample.png

핵심 점검 포인트는 storage 직접 조회, resize가 storage를 타는지, cache 두 번째 요청에서 hit가 나는지, Kafka UI에 이벤트가 쌓이는지입니다.