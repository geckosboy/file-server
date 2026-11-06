# CI/CD 실행 시간과 배포 안전성

기준일: 2026-11-03. 범위는 기존 단계 0~5와 runtime(storage/resize/cache)·admin(telemetry-api/admin-web) 배포다. TypeScript 7, 선택 단계 6, 실제 운영 배포는 이 점검에서 실행하지 않는다. 두 그룹은 독립 선택되며 관리자만 변경하면 이미지 처리 서비스 세 개를 빌드하거나 교체하지 않는다. PostgreSQL/Kafka/Nginx와 운영 migration은 별도 준비한다.

## 1. 불필요한 시간을 없앤 부분

| 기존 | 변경 | quality/build | system/lifecycle/ACL | runtime image 3개 | admin image 2개 |
| --- | --- | --- | --- | --- |
| docs/artifact만 | 생략 | 생략 | 생략 | 생략 |
| admin-web만 | 실행 | 생략 | 생략 | 실행 |
| telemetry-api만 | 실행 | 실행 | 생략 | 실행 |
| storage/resize/cache만 | 실행 | 실행 | 실행 | 생략 |
| libs/Prisma/workflow/lockfile | 실행 | 실행 | 실행 | 실행 |
| 그룹별 Dockerfile/smoke | 필요한 quality | 기존 영향 경로 유지 | 해당 그룹만 | 해당 그룹만 |
| 공유 image-groups smoke/boundary | quality | 생략 | 실행 | 실행 |

일반 PR은 위 변경 영향만 검증한다. main에서는 **마지막 실제 배포 기준**의 미전달 runtime/admin 변경도 각각 합쳐 선택한다. 새로운 generic deploy job이 성공한 이력이 없으면 최초 한 번 두 그룹 모두 선택한다.

항상 실행하는 **`CI result`**가 선택된 모든 gate의 실패/취소를 합산한다. Workflow-level `paths`로 required check 자체를 pending에 두지 않는다. Branch protection은 이 단일 최종 check를 required로 지정하는 방식에 맞춘다. 기존 required check 이름 변경은 원격 설정이므로 여기서 수정하지 않았다.

### main의 연속 push와 재실행

`event.before`만 비교하면 서버 변경 A 뒤 문서 변경 B가 A의 CI를 취소하고 검증을 건너뛸 수 있다. 그래서 main은 두 기준을 별도로 조회한다.

- **마지막 성공한 동일 저장소 main-push CI head**: 이미 검증한 코드의 unit/build/system/ACL을 반복하지 않는다.
- **마지막 실제 deploy job 성공 head**: CI만 성공하고 배포하지 못한 서버·관리자 변경은 최신 head의 해당 그룹 Docker build/smoke/push 대상으로 남긴다. 전체 workflow 성공이라도 deploy job이 skipped이면 배포 완료로 보지 않는다.

조회는 read-only Actions API, 최대 최근 30개 run, 조회별 8초 deadline이다. CI 기준을 찾지 못하면 모든 검증을, 배포 기준을 찾지 못하면 image gate를 실행하고 이유를 로그에 남긴다. 첫 적용/권한 부족/긴 배포 중단에서는 보수적으로 더 실행될 수 있다. 이미 검증·배포된 코드의 docs-only main push는 무거운 작업을 생략한다. `workflow_dispatch`와 전체 재실행은 full 검증이다.

실패 job만 재실행할 때 성공한 producer를 다시 빌드하지 않는다. backend/image artifact 이름은 **run ID**에 묶이고 producer 재실행 시 overwrite된다. Image manifest의 producer attempt는 같은 repository/SHA/run 안에서 현재 성공 CI attempt 이하만 허용한다. 미래 attempt/다른 run·commit·repository는 거부하고 release intent는 현재 attempt와 정확히 일치해야 한다.

## 3. 이미지 전달·권한 계약

1. CI에서 선택된 그룹의 `linux/amd64` 이미지만 한 번 build한다. `org.opencontainers.image.revision`은 해당 source SHA다.
2. loopback/network boundary, 실제 PostgreSQL/Kafka readiness, non-root/env secret 경계, production schema preflight를 smoke test한다.
3. **main push 전용 `docker-release` job만** `packages:write`를 가진다. PR/manual용 `docker-smoke` job은 read-only이고 registry token을 받지 않는다. 두 job은 같은 composite 구현을 쓰지만 하나만 실행되며, login은 smoke 성공 후에 한다.
4. main job은 mutable local tag가 아닌 **실제 테스트한 image ID**를 tag/push하고 push 후 동일 ID/revision/platform을 다시 확인한다. 선택된 모든 push가 성공한 뒤 source repository/SHA/run/producer attempt, selectedGroups, image ID/revision/platform과 immutable registry digest를 schema 3 manifest로 보관한다. registry tag는 `ci-<run>-<attempt>` 후보 표시이며 production 승인이 아니다.
5. 모든 선택 gate 성공 후 작은 release-intent artifact를 쓴다. **main publishing job 성공**으로만 `deploy=true`를 정한다. docs-only 변경은 명시적으로 `deploy=false`, `selectedGroups=[]`다. admin-only는 관리자 두 이미지를 배포한다. manifest 누락을 정상 skip으로 추측하지 않는다.
6. CD는 성공한 same-repository main push만 받는다. workflow SHA, event source SHA, 현재 main checkout이 모두 같아야 한다. 오래된 성공 run을 새 배포로 적용하지 않는다.
7. 정확한 run ID의 intent/manifest만 임시 디렉터리로 받아 source와 선택된 image ID/revision/platform 및 허용한 owner/app의 registry digest를 확인한다. 독립적으로 검증한 intent의 selectedGroups와 manifest의 그룹·이미지 집합이 정확히 같아야 한다. **CD에는 build/load/push 및 package-write 권한이 없다.** registry digest 자체가 불변 content identity다.
8. 배포는 `ghcr.io/<owner>/<app>@sha256:...`를 사용한다. `latest`나 commit-SHA alias를 더 이상 발행하지 않는다. registry를 직접 사용하는 운영 도구는 CD가 전달한 digest로 전환해야 한다. HTTP/Kafka 공개 계약에는 변경이 없다.

Backend dist는 1일, release intent와 작은 image manifest는 2일 보관한다. 만료·검증 실패 시 재빌드 fallback으로 가리지 않고 실패한다. 이미 발행된 registry digest는 artifact 보존 기간과 별개다. 현재 검증·배포 대상은 `linux/amd64` 단일 플랫폼이다.

권한이 필요한 dependency 설치·테스트는 **trusted main에서만** 수행하는 명시적 trade-off다. 다른 gate가 실패하면 후보 image가 registry에 남을 수 있지만 CD는 실행하지 않는다. registry 후보 보존 정책은 active deployment digest를 제외해 별도로 설정해야 하며, 이 작업에서는 registry를 삭제하거나 broad GC를 자동화하지 않는다.

## 4. 운영 배포와 rollback

등록된 배포 runner 이름은 `file-server-runner`이며, workflow는 이름이 아니라 `self-hosted`, `production`, `puddingii` 세 label을 모두 가진 runner를 선택한다. `linux`, `x64`, `file-server` label은 selector에 넣지 않는다. 실행 환경 자체에는 Bash 4+/Docker/curl과 linux/amd64 호환성이 필요하며 기존 Nginx ingress, DB/Kafka와 `file_dump_volume`을 유지한다. CI 및 release 명세 검증은 기존 GitHub-hosted 구성을 유지하고 production runner로 옮기지 않는다.

필요한 GitHub Actions secrets:

- `STORAGE_ENV_PATH`, `RESIZE_ENV_PATH`, `CACHE_ENV_PATH`: runtime 그룹의 운영 env 파일 경로. 각각 `DATABASE_URL`과 서비스 설정을 포함한다.
- `TELEMETRY_API_ENV_PATH`, `ADMIN_WEB_ENV_PATH`: 관리자 API/화면 운영 env 파일 경로. API에는 `DATABASE_URL`, 두 파일에는 같은 `TELEMETRY_ADMIN_TOKEN`이 필요하다. admin-web에는 DB URL이 필요 없다. 선택된 DB 앱들의 DATABASE_URL은 완전히 동일해야 한다(다른 DB를 한 번의 schema 검사로 가리는 것을 방지).
- `STORAGE_PORT`, `RESIZE_PORT`, `CACHE_PORT`, `TELEMETRY_API_PORT`, `ADMIN_WEB_PORT`: 선택된 서비스별로 서로 다른 1~65535 포트. env 파일의 실제 `PORT`와 일치해야 한다. 보통 3032/3031/3030/3100/3000을 사용한다.
- `FILE_SERVER_NET`, `KAFKA_NET`: 존재하는 서로 다른 두 Docker network.
- `GITHUB_TOKEN`: CI의 trusted-main `docker-release`만 `packages:write`, CD release 검증은 `actions:read`, production job은 `packages:read`로 제한한다.

운영 파일에는 비밀을 포함하므로 저장소·artifact·빌드 context에 넣지 않는다.

Schema preflight의 DB role은 `_prisma_migrations`의 migration 이름·완료·rollback 시각과 PostgreSQL index catalog를 읽을 수 있어야 한다. 별도 migrator role을 쓰는 운영에서는 필요한 metadata에만 read 권한을 부여하며 app role을 DB 관리자 권한으로 올리지 않는다. 권한이 없으면 preflight가 실패하고 기존 컨테이너는 유지된다. `DEPLOY_READY_TIMEOUT_SECONDS`는 script에서 1~90초 범위로만 조정할 수 있고 workflow 기본값은 90초다.

`scripts/deploy-image-services.sh`의 순서:

1. selectedGroups의 env/port/network, immutable image pull/platform을 먼저 확인한다. runtime을 선택했을 때만 기존 `file_dump_volume`을 요구한다. admin-only에는 storage/resize/cache 입력이 필요 없다. 관리 token 불일치, proxy secret 누락, 정해진 내부 endpoint가 아닌 API URL는 기존 컨테이너 변경 전에 거부한다. env는 source/eval하지 않는다.
2. 선택된 storage image 또는 admin-only일 때 telemetry-api image 안에서 **read-only**로 모든 checked-out Prisma migration의 성공 상태와 두 backfill index의 valid/ready를 검사한다. 과거 rolled-back attempt 뒤 성공한 재실행은 허용하고 해결되지 않은 attempt는 거부한다. DB 연결과 query deadline은 각각 5초다.
3. 선택된 모든 candidate를 **정지 상태로** 만들고 FILE network에 연결한다. backend 네 개는 Kafka network에도 연결하지만 admin-web은 연결하지 않는다. host publish는 127.0.0.1, container HOST는 0.0.0.0이며 Next standalone에는 HOSTNAME도 0.0.0.0으로 지정한다. 이 단계까지 기존 서비스는 멈추지 않는다.
4. 선택된 그룹을 storage → resize → cache → telemetry-api → admin-web 순서로 기존 컨테이너를 backup 이름으로 보관하고 candidate를 canonical 이름으로 시작한다. `/health/ready`를 확인하며 connect 1초, 요청 최대 3초, 전체 교체 readiness deadline은 최대 90초다. 준비됐다면 별도 고정 sleep 없이 다음 서비스로 진행한다.
5. 하나라도 실패하거나 SIGINT/SIGTERM을 받으면 이전에 교체한 서비스까지 역순으로 복원하고 기존 실행 상태와 readiness를 확인한다. 복구 실패는 ERROR로 남기며 성공처럼 보고하지 않는다.
6. 선택된 모든 서비스가 준비된 뒤 배포를 commit하고 backup을 정리한다. backup GC 실패로 건강한 신규 서비스를 다시 제거하지 않는다. 해당 cleanup 실패는 CI/CD에 그대로 보고한다.

**운영 migration/backfill/cutover를 자동 실행하지 않는다.** [lifecycle runbook](image-asset-lifecycle-runbook.md)의 expand/migrate/index 확인과 backfill/drain 절차가 먼저다. 이 preflight가 미적용 schema에서 기존 컨테이너를 제거하는 일을 막는다. Container rollback은 DB schema/data를 되돌리지 않는다.

이는 **무중단 배포가 아니다.** candidate는 기존 volume을 사용하므로 이전 인스턴스와 동시에 실행하지 않는다. SIGKILL/host 장애는 Bash trap으로 복구할 수 없으며, 남은 candidate/backup과 health를 운영자가 확인해야 한다. Production concurrency는 실행 중 배포를 취소하지 않고, CI는 오래된 branch run을 취소한다.

## 5. 검증·cleanup과 비용 경계

```bash
pnpm test:scripts
actionlint .github/workflows/ci.yml .github/workflows/deploy.yml
shellcheck scripts/deploy-image-services.sh
pnpm all:lint
pnpm all:typecheck
pnpm all:build
pnpm docker:build
pnpm docker:build:admin
pnpm test:docker:smoke
pnpm test:docker:admin:smoke
pnpm test:deployment:boundary
pnpm test:system:e2e
```

CI 각 infra job은 고유 `fs-*-ci-<run>-<attempt>` project와 label을 사용한다. 정상/실패/취소 후 `always()`에서 해당 container/network/volume만 제거하고 잔존 0건을 확인한다. teardown 오류를 삼키지 않으며 broad prune은 없다. 생성된 image/manifest와 BuildKit cache는 **의도한 build output**으로, runtime cleanup 대상이 아니다. Hosted runner 자체는 job 종료 후 폐기된다.

Deploy fault-injection은 fake Docker/curl regression으로 입력 오류, schema 거부, 전체 rollback, SIGTERM, backup GC 실패를 검사한다. 실제 storage Docker 안의 Prisma module resolution과 PostgreSQL migration/index query는 smoke에서 별도로 실행한다. 로컬 격리 registry로 candidate push·digest content hash·pull identity를 검증했다. 원격 GHCR push, 실제 self-hosted production 교체, 원격 branch protection, GHA cache hit/전송 비용은 로컬 PASS로 대신하지 않는다.

### 이번 로컬 실행 근거

- 단위 **545 PASS**와 실제 PostgreSQL 전용 **3/3 PASS**, component **38/38 PASS**
- 전체 lint **11/11**, 기본 TypeScript **5.9.3**와 Next typegen, build **11/11 PASS**
- 네 Dockerfile의 manifest-first image build, 실제 Docker smoke/schema preflight(**11 migrations + 2 indexes**), loopback/network boundary PASS
- 동일 run app+lib archive 복원 후 **skip-build system E2E PASS**: tenant 403, replica rate-limit 429, cache chain, Kafka poison/DLQ/lag 복구, PostgreSQL 장애·offset/outbox 재전달
- 실제 loopback registry로 세 tested image ID push, content hash와 digest pull identity 검증 PASS. 전달 manifest **1,388 bytes**. 로컬 push+확인 **3.681초**이며 GHCR/GitHub 네트워크의 실행 시간은 아니다.
- [로컬 리허설 JSON](../artifacts/ci-cd-audit/local-rehearsal.json)에 당시 app 기준 commit과 미커밋 CI/CD 범위, image ID/digest, 폐기한 대용량 artifact 실험을 구분해 기록했다. 실제 registry·테스트 DB/Kafka container/network/volume은 scoped cleanup 후 잔존 0건이다.
- Script regression, actionlint, shellcheck, 문서 형식·diff 검사와 독립 code/architecture review를 수행했다. lifecycle/ACL gate는 누락·축소하지 않았으며, 이 CI/CD 변경 검증에서는 직전 완료 감사의 full lifecycle/ACL 실행을 다시 반복하지 않았다.

Actions는 full commit SHA로 고정하고 Dependabot의 월 단위 단일 grouped PR로 갱신한다. 검증 없이 action major, Node matrix, dependency를 늘리지 않는다.

## 6. 근거

- [Docker GHA cache scope](https://docs.docker.com/build/cache/backends/gha/)
- [Docker: 검토 후 제외한 image archive 전달 방식](https://docs.docker.com/build/ci/github-actions/share-image-jobs/)
- [GitHub workflow_run 보안·artifact 전달](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [GitHub concurrency와 workflow path filter](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)

## 7. 실제 CI clean-checkout 실패 복구

GitHub run `41588818391`, attempt 2에서 typecheck·Docker build·Kafka ACL 기동 실패가 확인됐다. 이전 로컬 PASS는 clean Git checkout 검증을 대신하지 못했다. 로컬에 남은 `dist`와 Git에 없는 legacy `libs/common-nest`가 두 결함을 가렸고, Kafka bind mount는 Linux의 UID/파일 권한 차이를 놓쳤다.

- Typecheck: `--noEmit`은 선언 파일을 생성하지 않는다. `libs/database` 검사만 source alias를 가진 전용 config로 수행하고 Next/Prisma 생성 타입도 검사 명령이 준비한다. 일반 build config는 그대로 검증한다. quality setup의 중복 Prisma 생성은 끈다.
- Database unit test의 ts-jest도 별도 spec config와 source mapper로 동일한 경계를 사용한다. 기존 `dist`가 없어도 테스트를 typecheck·실행하며 diagnostics를 끄거나 선행 전체 build로 가리지 않는다.
- Docker: workspace에서 제외되고 Git에도 없는 `common-nest/package.json` COPY를 네 Dockerfile에서 제거한다. COPY 입력의 존재 여부를 로컬 디렉터리가 아닌 **Git 추적 파일**로 검사한다.
- Kafka: synthetic E2E config만 directory `0755`/file `0644`로 만들어 broker UID 1000이 읽을 수 있게 한다. 인증·ACL·health timeout·전체 wait timeout은 완화하지 않는다. 기동 실패 시 health log/권한/credential을 가린 설정/broker log를 정리 전에 남기고 cleanup 실패도 전파한다.

후속 검증은 저장소 밖에 tracked source와 새 회귀 파일만 복사한 별도 Git tree에서 수행한다. `node_modules`, `dist`, `.next`, `.turbo`, tsbuildinfo, ignored source를 가져오지 않으며 Linux/Node 22.15에서 frozen install부터 시작한다. 실제 GitHub PR 실행 결과와 이 clean 검증 결과를 확인해야 복구 완료로 판단한다.

Turbo가 package 병렬화를 이미 담당하므로 CI의 각 Jest는 `--runInBand`로 실행한다. package마다 worker pool을 추가로 만들어 메모리와 process 수를 배증시키지 않으며 테스트·assertion·timeout은 줄이거나 완화하지 않는다. 중단한 무제한 worker 실험과 실패한 초기 clean unit 시도는 후속 PASS와 구분한다.

배포 rollback 회귀 테스트는 실제 3초 안에 mock Docker가 세 서비스까지 진행한다고 가정해 부하 상황에서 간헐적으로 실패했다. 해당 fixture에만 가상 시계를 사용해 cache readiness 실패와 전체 rollback을 결정적으로 검증한다. 실제 배포의 공유 deadline·HTTP timeout·복원 검증은 변경하지 않는다.

복구본의 별도 Linux tree에서 Node **22.15.0**, pnpm **10.15.0**, TypeScript **5.9.3**으로 frozen install 후 전체 lint **11/11**, source-only no-emit 검사 **12 config**, 단위 **545 PASS**, component E2E **38/38**, build **11/11**을 통과했다. Typecheck 직후에도 두 contract package의 `dist`가 없음을 확인했으며, 마지막 테스트 수정 후 script regression도 Linux에서 **63/63 PASS**했다. PostgreSQL 전용 단위 3개는 일반 unit 실행에서 기존대로 제외되므로 실제 DB 검증은 별도 system gate 결과로 판단한다. 실제 GitHub PR CI의 성공 여부는 로컬 결과와 구분해 해당 commit의 `CI result`에서 확인한다.

같은 source-only tree에서 네 Dockerfile을 모두 build하고 최종 storage/resize/cache image로 실제 PostgreSQL/Kafka Docker smoke와 schema preflight **11 migrations + 2 indexes**를 통과했다. Kafka ACL의 allow/deny 시나리오와 Linux UID의 config 읽기 경계도 검증했다. 기존 workflow timeout은 늘리지 않았으며 운영 배포·registry push는 실행하지 않았다.

## 8. 관리자 운영 배포 준비

### 서버와 GitHub 설정

운영 서버에 예를 들어 `/etc/file-server/telemetry-api.env`, `/etc/file-server/admin-web.env`를 만들고 Runner 계정만 읽도록 제한한다. 경로를 각각 `TELEMETRY_API_ENV_PATH`, `ADMIN_WEB_ENV_PATH` secret에 등록하고 포트 secret은 기본 구성이라면 `TELEMETRY_API_PORT=3100`, `ADMIN_WEB_PORT=3000`으로 등록한다. 포트를 바꾸면 admin-web API URL의 TELEMETRY_API_PORT와 Nginx upstream의 ADMIN_WEB_PORT도 함께 맞춘다. 이는 **서버 파일 경로와 포트**이며 env 내용 전체를 GitHub secret으로 전달하는 방식이 아니다. 관리 이미지 두 package의 GitHub Actions push/pull 접근 권한도 있어야 한다.

telemetry-api env는 `apps/telemetry-api/.env.local.example`을 기준으로 실제 DB/Kafka/인증 정보를 사용한다. admin API 인증 헤더는 **`x-admin-token`**이다. admin-web이 서버 측에서 이 헤더를 만들므로 브라우저에 token을 배포하지 않는다.

admin-web 최소 운영 설정 예:

```dotenv
NODE_ENV=production
PORT=3000
TELEMETRY_API_BASE_URL=http://file_server_telemetry-api:3100/api/admin
TELEMETRY_ADMIN_TOKEN=REPLACE_WITH_SAME_API_ADMIN_TOKEN
ADMIN_WEB_PROXY_SECRET=REPLACE_WITH_STRONG_RANDOM_PROXY_SECRET
ADMIN_WEB_AUTH_DISABLED=false
ADMIN_WEB_ENABLE_FIXTURES=false
```

운영 admin-web의 TELEMETRY_API_BASE_URL은 위 canonical telemetry container 주소와 TELEMETRY_API_PORT를 정확히 사용해야 한다. NEXT_PUBLIC_TELEMETRY_API_BASE_URL 선언은 거부한다. proxy secret은 무작위 ASCII 문자열 1~128 bytes 범위이며 보통 64자리 hex를 사용한다.

실제 secret을 예제 파일·image build args·`NEXT_PUBLIC_*`·Next config의 `env`에 넣지 않는다. Docker env 파일은 shell script가 아니므로 값에 shell용 따옴표를 임의로 추가하지 않는다. 기존 API key를 유지하면 `CLIENT_API_KEY_PEPPER`도 유지한다.

### Nginx 관리자 인증 경계

Nginx는 이번 앱 CD가 교체하지 않는 별도 운영 ingress다. Docker Nginx를 FILE_SERVER_NET에 연결하고 별도의 관리자 hostname을 `file_server_admin-web:3000`으로 proxy한다. `/admin` subpath를 임의로 붙이지 않는다(현재 Next basePath 없음).

[`docker/nginx/admin.conf.example`](../docker/nginx/admin.conf.example)은 TLS + Basic Auth 예시다. 실제 domain/certificate/htpasswd/proxy secret으로 바꾼 설정을 런타임 파일로 mount한다. 예제는 Docker DNS를 주기적으로 재조회해 컨테이너 교체 뒤 이전 IP를 계속 사용하지 않는다. Nginx가 사용자를 인증한 후 **x-file-admin-user와 x-file-admin-proxy-secret을 항상 덮어써야** 한다. 외부가 보낸 같은 이름의 header를 신뢰하면 안 된다. API는 공용 proxy route에 추가하지 않으며 DB/Kafka도 public admin hostname으로 노출하지 않는다.

standalone app에는 로그인 페이지가 없다. 익명 접근의 401은 정상이며 인증을 생략해 해결하지 않는다. `/health/live`와 `/health/ready`는 app 내부 probe용이며 공개 관리자 도메인에서는 차단한다. 실제 준비 확인은 readiness 외에도 인증된 UI가 실제 admin API 데이터를 읽는지 확인해야 한다.

### API는 정상인데 서비스 목록에 연결 오류가 표시될 때

`/services`는 `dynamic = 'force-dynamic'`으로 요청마다 렌더링한다. API URL/token은 build가 아니라 runtime에만 주입한다. 이 선언이 없으면 build 중 누락된 환경변수 예외를 페이지가 정상 fallback으로 처리하여, 연결 오류 HTML이 영구 정적 생성될 수 있다. `fetch`의 `cache: 'no-store'`만으로는 **fetch 전에 발생한 예외**를 방지하지 못한다.

API `/api/admin/client-services`가 인증된 요청에 200인데 `/services`만 오류라면, 운영 image의 `.next/prerender-manifest.json`에서 `/services`가 정적 route로 포함됐는지 확인한다. 비밀값을 출력하거나 build에 token을 넣어 해결하지 말고 수정된 admin-web image를 배포한다. admin Docker smoke는 기존 PostgreSQL/Kafka 실행 안에서 API 정상 시 `/services`의 실제 조회와 API 중단 시 오류/fixture 비활성 상태를 함께 확인한다. 추가 인프라나 별도 CI job은 필요 없다.

### 배포와 rollback 계약

- `DEPLOY_GROUPS=runtime`, `admin`, `runtime,admin`만 유효하다. Bash 직접 호출에서 미설정이면 기존 runtime 동작을 유지한다. CD는 검증한 intent의 값을 항상 명시한다.
- admin-only는 API → UI만 교체한다. runtime-only는 기존 관리자 컨테이너를 건드리지 않는다. 통합 배포에서 UI가 실패하면 앞서 교체한 runtime과 API도 모두 rollback한다.
- schema 2 release artifact는 새 CD에서 거부한다. 기존 성공 run의 artifact를 새 main에 재사용하지 않고, 새 main CI가 schema 3으로 선택 그룹과 정확한 image 집합을 발행해야 한다.
- DB migration/backfill과 PostgreSQL/Kafka/Nginx bootstrap은 여전히 자동 실행하지 않는다. 운영 container 교체는 짧은 중단이 있을 수 있고 DB rollback을 뜻하지 않는다.
- Next standalone/monorepo packaging은 [공식 output 문서](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)와 [사용 버전 16.2.9의 tracing 구현](https://github.com/vercel/next.js/blob/f37fad940522e000af5498209fd237d863b4fa16/packages/next/src/build/utils.ts#L1359-L1403)을 기준으로 한다. 정적 자산을 별도 복사하고 runtime secret으로 동작하는 image를 검증한다.

### 확장본 로컬 검증 근거

- 기본 TypeScript 5.9.3, 전체 lint 11/11, unit 545 PASS, component 38/38, build 11/11 PASS. 이 호스트 실행에는 변경 없는 package의 Turbo cache가 포함되며 clean CI 증거와 구분한다.
- script regression 80/80 PASS. 선택 그룹·미배포 baseline·schema3 intent/manifest·CLI 출력과 runtime3/admin2/통합5 rollback을 검증했다. SIGTERM fixture의 JSON 상태 저장도 atomic rename으로 만들어 부분 write를 읽지 않는다.
- tracked-only clean context에서 telemetry-api/admin-web 이미지 build와 실제 PostgreSQL/Kafka의 11 migrations/2 indexes, 익명·위조 인증 거부, 인증 UI의 실제 데이터 조회·static asset·secret 비노출을 검증했다.
- 공유 인프라 group entrypoint의 admin-only 모드와 실제 Docker loopback/network boundary PASS. API 중단 시 UI ready503/live200, 실제 Nginx TLS/Basic Auth와 header 덮어쓰기 및 다른 backend IP로 DNS 재해석도 PASS. 테스트의 self-signed loopback TLS와 운영 CA/certificate 검증은 별개다.
- 생성한 container/network/volume은 exact project cleanup 후 잔존 0건이다. 독립 code-reviewer APPROVE, architect CLEAR. 실제 GHCR push·서버 env 파일·인증서·production 교체는 로컬 결과로 대신하지 않는다.
