# OpenCode Adaptive Model Pool (OAMP)

[English](README.md) | 한국어

OAMP는 [OpenCode](https://opencode.ai) 플러그인입니다. 연결된 여러 공급자의 모델을 하나의 풀로 관리하고, 세 가지 근거로 순위를 매깁니다.
- 공개 벤치마크
- 실제 사용에서 드러난 품질
- 실측 응답 속도

장애가 난 경로는 피합니다. 표식 모델 **`oamp/auto`**를 고르면 OAMP가 턴마다 실제 모델을 정하고, 호출은 그대로 OpenCode가 합니다.

상태: 계획한 단계(0~5)를 모두 구현했습니다. 설계 이력은 [`docs/`](docs/)에 있습니다.

## 동작 방식

```text
oamp/auto 선택 ──▶ chat.message hook ──▶ 이번 턴의 표식 모델을 가장 좋은 건강한 경로로 교체
                                          (예: opencode/deepseek-v4.1-flash-free)
                                                  │
                         OpenCode가 그 경로를 직접 호출: OpenCode의 SDK 인스턴스, 헤더, 인증 사용
                                                  │
        event / chat.headers hook ◀── 계측: 첫 토큰 시간, 첫 답변 시간, 전체 응답 시간, 초당 토큰, 오류, 재시도
```

- **프록시를 쓰지 않습니다.** OAMP는 모델 요청을 직접 보내지 않습니다.
  - OpenCode가 직접 보낸 호출만 받는 공급자가 있기 때문입니다. OpenCode Zen 무료 모델이 그렇습니다.
  - OpenCode는 자기 공급자에게만 고유 헤더(`x-opencode-*`)를 붙입니다.
- `oamp/*` 모델은 메모리에만 존재하며, 실제로 호출되지 않는 선택 표식입니다.
  - `config` hook이 표식 공급자를 메모리에 넣습니다.
  - 이 공급자의 base URL은 discard 포트입니다.
- 세션에서 실제 모델을 직접 고르면 그 세션은 auto 모드가 꺼집니다. 수동 선택이 항상 우선합니다.

## 요구 사항

- **OpenCode 1.19.5**에서 검증했습니다([`docs/compatibility.md`](docs/compatibility.md) 참고).
  - OpenCode 1.19.5는 외부 V2 플러그인을 로드하지 않습니다. 그래서 OAMP는 **V1 플러그인 hook만** 씁니다.
- 실행에 `npm install`은 필요 없습니다.
  - 플러그인과 CLI는 OpenCode에 내장된 Bun 런타임에서 돕니다. `scripts/bun`은 `BUN_BE_BUN=1 ~/.opencode/bin/opencode`와 같습니다.
  - OpenCode 실행 파일 경로는 `OPENCODE_BIN`으로 바꿀 수 있습니다.
- 소스는 `node:*`와 `bun:sqlite`만 import합니다. Python 3는 필요 없습니다.

## 설치, 점검, 제거

```sh
git clone https://github.com/konor123/opencode-adaptive-model-pool
cd opencode-adaptive-model-pool
scripts/oamp install     # ~/.config/opencode/opencode.jsonc에 "plugin" 항목 하나를 추가합니다(백업 보관)
scripts/oamp doctor      # 설치, 옵션, 스키마, 공급자, 데이터 신선도, 최근 오류를 점검합니다
# OpenCode를 다시 시작한 뒤 oamp/auto를 고릅니다
scripts/oamp uninstall   # 그 항목을 다시 제거합니다
```

`install`과 `uninstall`은 `plugin` 항목 말고는 아무것도 바꾸지 않습니다.
- 파일을 고치는 경우는 하나뿐입니다. 표준 JSON(2칸 들여쓰기)으로 읽었다가 다시 쓴 결과가 원본과 바이트 단위로 같을 때입니다.
- 주석이 있거나 서식이 다른 파일은 건드리지 않고, 손으로 추가할 줄만 출력합니다.

```jsonc
{
  "plugin": [
    ["file:///path/to/opencode-adaptive-model-pool/src/index.ts", { "enabled": true }]
  ]
}
```

OAMP의 데이터는 `~/.local/share/oamp/`(`oamp.db`, `oamp.log`)에 있습니다. 흔적을 모두 지우려면 이 디렉터리를 삭제하면 됩니다.

## 사용법

- **`oamp/auto`**는 기본 풀입니다. **`oamp/fast`**는 후보는 같고 속도 비중이 더 큽니다.
- 표식 모델을 고르는 곳:
  - TUI 모델 선택(`/models`)
  - 에이전트의 `model` 필드
  - `opencode run --model oamp/auto "…"`
- **세션 고정**: 세션은 경로를 유지합니다. 다음 경우에만 바꿉니다.
  - 경로가 건강하지 않게 됐을 때
  - 컨텍스트가 그 경로에 더 이상 맞지 않을 때
  - 경로 제한(`routeLimits`)에 걸렸을 때
  - 다른 경로가 5점 이상 앞선 상태가 30분 동안 이어졌을 때
- **탐색**: 새 세션의 첫 턴에서 가끔(5%) 근거가 적은 경로를 시험합니다. 이미 약하다고 알려진 경로는 고르지 않습니다.
- **하위 에이전트**(task 도구)는 부모 세션의 auto 모드를 이어받습니다.

## 점수 산정

| 점수 | 정의 |
|---|---|
| 성능 `P` | `0.55·C + 0.30·A + 0.15·I` (코딩, 에이전트, 추론). 각 분류는 존재하는 지표의 가중 평균입니다. 가중치는 [`src/scoring/performance.ts`](src/scoring/performance.ts)에 있습니다. |
| 신뢰도 `c` | `coverage × match × recency × independence` |
| `P_eff` | `c·P + (1−c)·prior`. prior는 풀에서 근거가 있는 경로들의 `P` 중앙값입니다. 근거가 없는 모델을 "100점 만점에 50점"이 아니라 그 풀의 보통 수준으로 봅니다. |
| 속도 `L` | `0.35·TTFA + 0.45·E2E + 0.20·초당 토큰`. 로그 척도에 EWMA를 쓰고, 표본이 적은 경로는 중립값 쪽으로 당깁니다. |
| 가용성 `H` | 최근 결과의 `clamp(success_ewma, 0.5, 1)²`. 사용자 중단과 컨텍스트 초과는 세지 않습니다. |
| 경로 점수 `R` | `(0.7·P_eff + 0.3·L) × H`. `fast` 풀은 0.4 / 0.6입니다. |

근거 출처:
- **OpenRouter Benchmarks API**: 기존 OpenRouter 키를 씁니다.
  - Artificial Analysis의 코딩·에이전트·추론 지수를 다시 배포합니다.
  - OpenRouter 자체의 GPQA Diamond·tau-bench 결과도 줍니다.
- **Artificial Analysis 무료 API**(선택): 키 파일은 `~/.config/oamp/aa-api-key`입니다.
  - 추론 지수와 모델 단위 속도 사전값을 줍니다.
  - 같은 AA 측정이 두 출처에 모두 있으면 하나만 씁니다.
- **API가 없는 전문 리더보드**(Scale Labs SWE-Bench Pro V2, MCP Atlas): 날짜를 기록한 스냅샷으로 [`data/snapshots/`](data/snapshots/)에 둡니다.
  - 리더보드 전체를 정규화 모집단으로 씁니다.
  - 모델 이름 매핑은 직접 확인한 것만 넣습니다.
- **나의 실사용 기록**: OpenCode의 `opencode.db`를 읽기 전용으로 읽고, 최근 30일을 봅니다. 모델 탓으로 볼 수 있는 실패만 셉니다.
  - `usage_tools`: 인자가 스키마에 맞는 도구 호출의 비율. 30회 이상일 때 반영합니다.
  - `usage_edit`: 스키마 오류나 `oldString` 불일치 없이 끝난 edit·write·patch 호출의 비율. 20회 이상일 때 반영합니다.

벤치마크 지표는 모두 p5/p95 기준 범위로 정규화합니다. 기준 범위는 출처의 버전마다 처음 볼 때 한 번 고정합니다. 그래서 모델이 추가되거나 빠져도 기존 점수가 흔들리지 않습니다.

## 경로에 장애가 나면

- **Health 상태**는 호스트의 모든 OpenCode 프로세스가 공유합니다.
  - 일시 오류 → **cooldown**: 60 → 120 → 240 → 300초
  - 연속 3번째 실패 → **open**: 120초, 다시 열릴 때마다 2배, 최대 30분
  - 401·403·404 → **disabled**: 24시간. 401이면 그 공급자의 모든 경로가 대상입니다.
  - 기간이 끝나면 **probation**이 됩니다. 건강한 후보가 없을 때만 쓰고, 성공하면 다시 healthy가 됩니다.
- **같은 턴 안의 전환**(TUI와 `opencode serve`):
  1. auto 세션에서 OpenCode가 같은 모델로 재시도하기 시작합니다.
  2. OAMP가 그 턴을 중단합니다.
  3. 다음으로 건강한 경로로, 짧은 synthetic "continue" 메시지와 함께 턴을 이어 갑니다. 한 턴에 최대 2번까지입니다.
- OAMP는 요청을 직접 다시 보내지 않습니다. 이미 실행된 단계는 기록에 남아 있으므로 도구가 두 번 실행되지 않습니다.
- **`opencode run`에서는** 같은 턴 안의 전환을 끕니다.
  - `run`은 세션이 중단되는 즉시 종료하므로, 이어 간 답이 출력되지 않기 때문입니다.
  - 대신 OpenCode 자체 재시도에 맡기고, 실패한 경로는 다음 실행부터 피합니다.
- **경로 제한**: `routeLimits`는 경로당 동시 auto 세션 수를 제한합니다. EXAONE은 초당 1회 한도가 있습니다.
- 최근 10분 동안 요청의 20% 넘게 rate limit에 걸린 경로는 자동으로 세션 1개로 제한합니다.

## 설정

모든 옵션은 선택 사항입니다.
- 플러그인 항목의 두 번째 요소로 넘깁니다. 전체 목록과 기본값은 [`src/options.ts`](src/options.ts)에 있습니다.
- 잘못된 숫자 값(음수, NaN, 합이 0인 가중치 묶음)은 기본값으로 되돌아가고, `oamp doctor`가 알려 줍니다.

기본값은 이 프로젝트를 만든 배포 환경 기준입니다.
- 공급자: `opencode`, `openrouter`, `nvidia`
- OpenAI 호환 공급자 두 개: `xkiro`, `exaone`

환경에 맞게 바꿔 쓰세요.

```jsonc
["file:///path/to/opencode-adaptive-model-pool/src/index.ts", {
  "providers": ["opencode", "openrouter"],
  "policy": {
    "allowPaid": false,           // 가격이 알려진 유료 경로는 절대 고르지 않음
    "allowUnknownPrice": false,   // 가격 정보가 아예 없는 경로도 고르지 않음
    "freeDeclared": [],           // 무료라고 알고 있는 "provider/*" glob
    "deny": ["openrouter/openrouter/free"]
  },
  "providerSync": {},             // 공급자 /v1/models 동기화 (고정 엔드포인트: src/discovery/provider-api.ts)
  "weights": { "performance": 0.7, "latency": 0.3 },
  "pools": { "auto": {}, "fast": { "weights": { "performance": 0.4, "latency": 0.6 } } },
  "selector": { "switchMargin": 5, "switchHoldMinutes": 30, "explorationBudget": 0.05, "inTurnFailover": true, "maxSwitchesPerTurn": 2 },
  "routeLimits": { "exaone/*": { "maxSessions": 1 } }
}]
```

공급자 모델 목록 동기화(`providerSync`):
- `src/discovery/provider-api.ts`에 적힌 고정 HTTPS 엔드포인트만 호출합니다.
- 설정 파일을 고쳐 쓰던 cron 작업을 대체합니다. OAMP는 설정 파일을 쓰지 않고, 시작할 때 목록을 메모리에 넣습니다.

환경변수 `OAMP_OPTIONS='{"…": …}'`로 프로세스 단위로 옵션을 덮어쓸 수 있습니다. 별도 DB로 테스트할 때 유용합니다. 예: `{"storage": {"path": "/tmp/test.db"}}`

## CLI

```sh
# 조회
scripts/oamp status                 # 공급자별 경로, 동기화·실사용 가져오기·벤치마크·점수 상태
scripts/oamp rank [auto|fast]       # 선택자가 보는 값: R, P_eff, L, H, 표본 수, health
scripts/oamp perf                   # P_eff와 C/A/I 내역, 근거
scripts/oamp routes [--all] [--provider p]
scripts/oamp model <route>          # 경로 하나에 대해 아는 모든 것
scripts/oamp decisions [--limit n]  # 최근 선택 결정과 사유
scripts/oamp health                 # cooldown / open / disabled / probation 상태
scripts/oamp stats [--days 7]       # KPI(의도하지 않은 유료 호출 등)와 벤치마크-실사용 상관

# 갱신 (플러그인도 백그라운드에서 수행하며, 프로세스 간 lease로 한 번만 실행)
scripts/oamp refresh [--force]      # 공급자 모델 목록 + 경로 레지스트리
scripts/oamp bench [--force]        # 벤치마크 + 점수
scripts/oamp usage [--full]         # opencode.db에서 실사용 가져오기 + 재계산
scripts/oamp probe <route>          # `opencode run`으로 최소 요청 1회, probe 세션은 삭제

# 설치 관리
scripts/oamp install | uninstall | doctor
```

## 데이터, 네트워크, 자격증명

- **저장**: `~/.local/share/oamp/oamp.db`(WAL 모드 SQLite, 모든 OpenCode 프로세스가 공유)
  - 경로와 그 카탈로그 정보
  - 벤치마크 수치
  - 단계별 지표
  - Health 상태
  - 선택 결정
- 세션·메시지 ID는 SHA-256 해시로만 저장합니다. 프롬프트, 응답, 헤더, 키는 저장하지 않습니다.
- **읽기 전용으로 읽는 파일**:
  - OpenCode의 `opencode.db`
  - models.dev 캐시
  - OpenCode의 `auth.json`: 자격증명이 있는 공급자를 확인하고, OpenRouter Benchmarks API용 키를 얻는 데만 씁니다.
- **네트워크**: OpenRouter Benchmarks, Artificial Analysis API, 고정된 공급자 모델 목록 엔드포인트만 호출합니다.
  - 모두 HTTPS와 고정 URL을 쓰고, 리디렉션을 거부하며, 시간 제한이 있습니다.
  - 키는 로그, 오류 메시지, DB 어디에도 남지 않습니다.

## 한계

- **같은 턴 안의 전환**:
  - `opencode run --attach`로 TUI에 붙은 경우는 판별하지 못합니다.
  - 하위 에이전트 세션은 대상이 아닙니다. 하위 에이전트를 중단하면 부모의 task 호출이 실패하기 때문입니다.
- `config` hook으로 넣은 공급자 모델 목록은 다음 OpenCode 시작부터 반영됩니다.
- 플러그인이 로드되지 않았는데 `oamp/auto`가 선택돼 있으면, discard 포트로 향한 OpenCode 자체 재시도 끝에 약 65초 뒤 실패합니다.
- 전문 리더보드에 실린 무료 모델은 매우 적습니다. 2026-11-10 기준으로 근거가 있는 31개 모델 중 2개입니다.
- Terminal-Bench와 BFCL은 표가 클라이언트에서 그려지므로 수집하지 않습니다.
- 실사용 지표는 모델의 도구 호출이 충분히 쌓여야 생깁니다. 그 전까지 새 모델은 풀의 prior에 머뭅니다.
- `routeLimits.maxSessions`는 예약이 아니라 집계 방식입니다. 두 프로세스가 같은 순간에 시작하면 잠시 한도를 넘을 수 있습니다.

## 개발

```sh
npm install                # 개발용 의존성만: TypeScript와 타입 정의
scripts/bun test           # 단위 테스트 (메모리·임시 DB, 가짜 fetch, 네트워크 없음)
npx tsc --noEmit -p .
```

- [`docs/plan-v1.3.md`](docs/plan-v1.3.md): 설계와 단계별 결과. 이전 플랜 버전도 같은 디렉터리에 있습니다.
- [`docs/compatibility.md`](docs/compatibility.md): OAMP가 기대는 OpenCode 1.19.5의 동작
- [`docs/reviews/`](docs/reviews/): 독립 코드 검토와 그에 대한 조치

## 출처 표기

벤치마크 데이터는 [Artificial Analysis](https://artificialanalysis.ai)와 [OpenRouter](https://openrouter.ai/rankings)에서, 전문 리더보드 스냅샷은 [Scale Labs](https://labs.scale.com/leaderboard)에서 가져왔습니다. 각 출처와 조회 날짜는 데이터와 함께 기록합니다.
