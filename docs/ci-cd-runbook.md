# CI/CD 실행 시간과 배포 안전성

기준일: 2026-11-03. 범위는 기존 단계 0~5와 storage/resize/cache 배포다. TypeScript 7, 선택 단계 6, 실제 운영 배포는 이 점검에서 실행하지 않는다. telemetry-api/admin-web의 host build는 CI에 포함되지만 운영 컨테이너 배포는 기존과 같이 이 CD의 관리 대상이 아니다.

## 1. 불필요한 시간을 없앤 부분

| 기존                                                         | 변경                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| quality 전체가 끝난 후 모든 infra gate 시작                  | quality와 build, ACL, Docker가 필요한 의존성만 따라 병렬 실행                           |
| quality, system, lifecycle에서 같은 backend를 3번 host build | host build 1번, 같은 run의 app/lib dist를 두 E2E가 재사용                               |
| CI Docker build 3번 + CD 재빌드 3번                          | CI에서 3개 build/smoke/push, CD는 작은 immutable digest 명세만 확인                     |
| 소스 수정마다 pnpm install layer 무효화                      | package manifest → frozen install → source 순서로 네 Dockerfile의 dependency layer 분리 |
| CI Docker layer cache 없음                                   | storage/resize/cache별 GHA scope로 layer cache 재사용                                   |
| 관리자 UI만 바꿔도 Kafka와 세 Docker image 검증              | 영향받은 gate만 선택. docs/artifact는 일반적으로 경량 check만 실행                      |
| ACL gate를 위해 pnpm/Node 설정                               | broker CLI만 사용하므로 checkout 후 Bash로 실행                                         |
| PostgreSQL 전용 단위 테스트 3건은 CI에서도 skip              | 이미 띄운 system E2E DB를 재사용해 repository/retention 검증, 새 DB job 없음            |

**실제 GitHub Actions의 전후 실행 시간/비용 절감률은 측정하지 않았다.** 원격 default branch에서 이 workflow의 실행 이력을 조회할 수 없어, 구조상 제거한 build 수와 로컬 검증만 보고한다. Runner 수 증가와 artifact 전송 비용도 있으므로 “몇 % 빨라졌다”는 수치는 주장하지 않는다.

초기 검증에서 image archive는 **348,913,398 bytes**, 로컬 export **20.646초** + load/검증 **10.267초**였다. GitHub 전송 전에도 약 31초가 추가되어, 이 대용량 전달 방식은 **최종 설계에서 제거**했다. 최종 방식은 trusted main job의 registry push와 수 KB manifest 전달이며 CI/CD 사이에 image save/gzip/load를 하지 않는다.

새 100만 건 benchmark, 반복 soak, 추가 버전 matrix를 매 PR에 넣지 않는다. 기존 full lifecycle의 crash/variant/delete/capacity와 Kafka ACL은 영향받는 서버 변경에서 유지한다. hash 계약이 불완전한 `.turbo`를 cross-run cache로 저장해 테스트를 건너뛰는 최적화도 하지 않는다.

## 2. 어떤 변경에서 무엇을 실행하는가

일반 PR은 PR base부터 현재 checkout까지의 파일 차이로 선택한다.

| 변경                                          | quality | host build | system/lifecycle | Docker 3개 | Kafka ACL |
| --------------------------------------------- | ------- | ---------- | ---------------- | ---------- | --------- |
| docs/artifact만                               | 생략    | 생략       | 생략             | 생략       | 생략      |
| admin-web만                                   | 실행    | 실행       | 생략             | 생략       | 생략      |
| telemetry-api만                               | 실행    | 실행       | 실행             | 생략       | 실행      |
| storage/resize/cache, libs, Prisma            | 실행    | 실행       | 실행             | 실행       | 실행      |
| deploy Bash/test만                            | 실행    | 생략       | 생략             | 생략       | 생략      |
| runtime Dockerfile만                          | 실행    | 생략       | 생략             | 실행       | 생략      |
| workflow/composite setup, lockfile, 핵심 설정 | 실행    | 실행       | 실행             | 실행       | 실행      |

항상 실행하는 **`CI result`**가 선택된 모든 gate의 실패/취소를 합산한다. Workflow-level `paths`로 required check 자체를 pending에 두지 않는다. Branch protection은 이 단일 최종 check를 required로 지정하는 방식에 맞춘다. 기존 required check 이름 변경은 원격 설정이므로 여기서 수정하지 않았다.

### main의 연속 push와 재실행

`event.before`만 비교하면 서버 변경 A 뒤 문서 변경 B가 A의 CI를 취소하고 검증을 건너뛸 수 있다. 그래서 main은 두 기준을 별도로 조회한다.

- **마지막 성공한 동일 저장소 main-push CI head**: 이미 검증한 코드의 unit/build/system/ACL을 반복하지 않는다.
- **마지막 실제 deploy job 성공 head**: CI만 성공하고 배포하지 못한 서버 변경은 최신 head의 Docker build/smoke/push 대상으로 남긴다. 전체 workflow 성공이라도 deploy job이 skipped이면 배포 완료로 보지 않는다.

조회는 read-only Actions API, 최대 최근 30개 run, 조회별 8초 deadline이다. CI 기준을 찾지 못하면 모든 검증을, 배포 기준을 찾지 못하면 image gate를 실행하고 이유를 로그에 남긴다. 첫 적용/권한 부족/긴 배포 중단에서는 보수적으로 더 실행될 수 있다. 이미 검증·배포된 코드의 docs-only main push는 무거운 작업을 생략한다. `workflow_dispatch`와 전체 재실행은 full 검증이다.

실패 job만 재실행할 때 성공한 producer를 다시 빌드하지 않는다. backend/image artifact 이름은 **run ID**에 묶이고 producer 재실행 시 overwrite된다. Image manifest의 producer attempt는 같은 repository/SHA/run 안에서 현재 성공 CI attempt 이하만 허용한다. 미래 attempt/다른 run·commit·repository는 거부하고 release intent는 현재 attempt와 정확히 일치해야 한다.

## 3. 이미지 전달·권한 계약

1. CI에서 `linux/amd64` 세 이미지를 한 번 build한다. `org.opencontainers.image.revision`은 해당 source SHA다.
2. loopback/network boundary, 실제 PostgreSQL/Kafka readiness, non-root/env secret 경계, production schema preflight를 smoke test한다.
3. **main push 전용 `docker-release` job만** `packages:write`를 가진다. PR/manual용 `docker-smoke` job은 read-only이고 registry token을 받지 않는다. 두 job은 같은 composite 구현을 쓰지만 하나만 실행되며, login은 smoke 성공 후에 한다.
4. main job은 mutable local tag가 아닌 **실제 테스트한 image ID**를 tag/push하고 push 후 동일 ID/revision/platform을 다시 확인한다. 세 push가 모두 성공한 뒤 source repository/SHA/run/producer attempt, image ID/revision/platform과 immutable registry digest만 manifest로 보관한다. registry tag는 `ci-<run>-<attempt>` 후보 표시이며 production 승인이 아니다.
5. 모든 선택 gate 성공 후 작은 release-intent artifact를 쓴다. **main publishing job 성공**으로만 `deploy=true`를 정한다. docs/admin-only 변경은 명시적으로 `deploy=false`다. manifest 누락을 정상 skip으로 추측하지 않는다.
6. CD는 성공한 same-repository main push만 받는다. workflow SHA, event source SHA, 현재 main checkout이 모두 같아야 한다. 오래된 성공 run을 새 배포로 적용하지 않는다.
7. 정확한 run ID의 intent/manifest만 임시 디렉터리로 받아 source와 세 image ID/revision/platform 및 허용한 owner/app의 registry digest를 확인한다. **CD에는 build/load/push 및 package-write 권한이 없다.** registry digest 자체가 불변 content identity다.
8. 배포는 `ghcr.io/<owner>/<app>@sha256:...`를 사용한다. `latest`나 commit-SHA alias를 더 이상 발행하지 않는다. registry를 직접 사용하는 운영 도구는 CD가 전달한 digest로 전환해야 한다. HTTP/Kafka 공개 계약에는 변경이 없다.

Backend dist는 1일, release intent와 작은 image manifest는 2일 보관한다. 만료·검증 실패 시 재빌드 fallback으로 가리지 않고 실패한다. 이미 발행된 registry digest는 artifact 보존 기간과 별개다. 현재 검증·배포 대상은 `linux/amd64` 단일 플랫폼이다.

권한이 필요한 dependency 설치·테스트는 **trusted main에서만** 수행하는 명시적 trade-off다. 다른 gate가 실패하면 후보 image가 registry에 남을 수 있지만 CD는 실행하지 않는다. registry 후보 보존 정책은 active deployment digest를 제외해 별도로 설정해야 하며, 이 작업에서는 registry를 삭제하거나 broad GC를 자동화하지 않는다.

## 4. 운영 배포와 rollback

등록된 배포 runner 이름은 `file-server-runner`이며, workflow는 이름이 아니라 `self-hosted`, `linux`, `x64`, `production`, `puddingii` label을 모두 가진 runner를 선택한다. `file-server` label은 필요하지 않다. Bash 4+/Docker/curl과 linux/amd64 실행 환경이 필요하며 기존 Nginx ingress, DB/Kafka와 `file_dump_volume`을 유지한다. CI 및 release 명세 검증은 기존 GitHub-hosted 구성을 유지하고 production runner로 옮기지 않는다.

필요한 기존 secrets:

- `STORAGE_ENV_PATH`, `RESIZE_ENV_PATH`, `CACHE_ENV_PATH`: runner 파일시스템의 읽을 수 있는 runtime env 파일. 각각 `DATABASE_URL`과 서비스 설정을 포함한다.
- `STORAGE_PORT`, `RESIZE_PORT`, `CACHE_PORT`: 서로 다른 1~65535 포트. env 파일의 실제 `PORT`와 일치해야 한다.
- `FILE_SERVER_NET`, `KAFKA_NET`: 존재하는 서로 다른 두 Docker network.
- `GITHUB_TOKEN`: CI의 trusted-main `docker-release`만 `packages:write`, CD release 검증은 `actions:read`, production job은 `packages:read`로 제한한다.

운영 파일에는 비밀을 포함하므로 저장소·artifact·빌드 context에 넣지 않는다.

Schema preflight의 DB role은 `_prisma_migrations`의 migration 이름·완료·rollback 시각과 PostgreSQL index catalog를 읽을 수 있어야 한다. 별도 migrator role을 쓰는 운영에서는 필요한 metadata에만 read 권한을 부여하며 app role을 DB 관리자 권한으로 올리지 않는다. 권한이 없으면 preflight가 실패하고 기존 컨테이너는 유지된다. `DEPLOY_READY_TIMEOUT_SECONDS`는 script에서 1~90초 범위로만 조정할 수 있고 workflow 기본값은 90초다.

`scripts/deploy-image-services.sh`의 순서:

1. 모든 env/port/network/기존 storage volume, immutable image pull/platform을 먼저 확인한다.
2. 새 storage runtime 안에서 **read-only**로 모든 checked-out Prisma migration의 성공 상태와 두 backfill index의 valid/ready를 검사한다. 과거 rolled-back attempt 뒤 성공한 재실행은 허용하고 해결되지 않은 attempt는 거부한다. DB 연결과 query deadline은 각각 5초다.
3. 세 candidate를 **정지 상태로** 만들고 FILE network와 Kafka network를 모두 연결한다. host publish는 127.0.0.1, container HOST는 0.0.0.0이다. 이 단계까지 기존 서비스는 멈추지 않는다.
4. storage → resize → cache 순서로 기존 컨테이너를 backup 이름으로 보관하고 candidate를 canonical 이름으로 시작한다. `/health/ready`를 확인하며 connect 1초, 요청 최대 3초, 전체 교체 readiness deadline은 최대 90초다. 준비됐다면 별도 고정 sleep 없이 다음 서비스로 진행한다.
5. 하나라도 실패하거나 SIGINT/SIGTERM을 받으면 이전에 교체한 서비스까지 역순으로 복원하고 기존 실행 상태와 readiness를 확인한다. 복구 실패는 ERROR로 남기며 성공처럼 보고하지 않는다.
6. 세 서비스 모두 준비된 뒤 배포를 commit하고 backup을 정리한다. backup GC 실패로 건강한 신규 서비스를 다시 제거하지 않는다. 해당 cleanup 실패는 CI/CD에 그대로 보고한다.

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
pnpm test:docker:smoke
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
