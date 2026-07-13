# D2TZ Diablo Clone Discord Alert

D2TZ Diablo Clone 상태를 GitHub Actions scheduled workflow로 5분마다 확인하고, 조건에 맞으면 Discord Webhook으로 알림을 보냅니다.

## 동작 방식

- `GET https://api.d2tz.info/public/dc?region=all`을 한 번만 호출합니다.
- 인증은 `Authorization: ${D2TZ_API_TOKEN}` HTTP Header를 사용합니다.
- 필터 조건은 `region in ["us", "eu", "asia"]`, `state >= 3`입니다.
- 같은 region의 같은 state는 중복 알림을 보내지 않습니다.
- state가 5로 올라가면 다시 알림을 보냅니다.
- state가 0~2로 내려가거나 대상 상태가 없으면 해당 region의 알림 기록을 초기화합니다.
- 운영 환경에서는 Upstash Redis에 마지막 알림 state를 저장합니다.
- Redis 환경변수가 없으면 로컬 개발용으로 `.dclone-state.json` 파일을 사용합니다.

## GitHub Secrets

GitHub 저장소에서 `Settings` > `Secrets and variables` > `Actions` > `New repository secret`으로 아래 값을 등록합니다.

```bash
D2TZ_API_TOKEN=your_d2tz_api_token
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

## GitHub Actions

Workflow 파일은 `.github/workflows/dclone-alert.yml`입니다.

```yaml
on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch:
```

5분마다 하루 약 288회 API를 호출하므로, d2tz API 제한인 하루 2000회보다 낮습니다. GitHub Actions scheduled workflow는 부하 상황에 따라 정확히 5분 정각에 실행되지 않고 지연될 수 있습니다.

## Actions 활성화

1. 이 저장소를 GitHub에 push합니다.
2. GitHub 저장소의 `Actions` 탭을 엽니다.
3. Actions가 비활성화되어 있으면 `I understand my workflows, go ahead and enable them`을 선택합니다.
4. `.github/workflows/dclone-alert.yml` workflow가 보이는지 확인합니다.

## 첫 배포 후 테스트

1. GitHub Secrets 4개가 모두 등록되어 있는지 확인합니다.
2. `Actions` 탭에서 `DClone Alert` workflow를 선택합니다.
3. `Run workflow` 버튼으로 수동 실행합니다.
4. 실행 로그에서 `Check Diablo Clone state` step의 JSON 출력이 `ok: true`인지 확인합니다.
5. 현재 DClone 상태가 조건에 맞으면 Discord 채널에 알림이 도착합니다. 조건에 맞지 않으면 알림 없이 성공 로그만 남습니다.

## 로컬 실행

이미 프로젝트 루트의 `.env`에 토큰과 URL을 넣었다면 아래처럼 실행합니다.

```bash
npm install
npm run check:dclone:local
```

`.env` 예시:

```bash
D2TZ_API_TOKEN=your_d2tz_api_token
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

`check:dclone:local`은 Node.js의 `--env-file=.env` 옵션으로 `.env`를 읽은 뒤 `src/check-dclone.ts`를 실행합니다. GitHub Actions에서는 Secrets가 환경변수로 들어오므로 기존 `npm run check:dclone`을 사용합니다.

## 타입체크

```bash
npm run typecheck
```
