# OpenCode Adaptive Model Pool (OAMP) 개발 계획 — 구체화본

- 버전: v1.1 (v1.0 구체화·정정본, 원본: `docs/plan-v1.0.md`)
- 작성일: 2026-11-10
- 기준 환경: GCE, OpenCode 바이너리 **1.19.5**, `@opencode-ai/plugin` 1.19.3 설치(npm 최신 1.19.5, V2 타입 동일)
- 표기: ✅ = 이번 조사에서 파일·명령·문서로 확인 / ⚠ = 미확인, Phase 0 실험으로 판정 / 💡 = v1.1에서 새로 제안한 설계

---

## 0. v1.0 대비 핵심 변경 요약

| # | v1.0 | v1.1 | 근거 |
|---|---|---|---|
| 1 | `ctx.model.list`, `ctx.session.switchModel`, `ctx.session.hook("http.request"/"retry")` 사용 | 설치된 패키지에는 해당 API가 없다. **실제 V2 API(`catalog`, `aisdk`, `agent`, `integration`) + V1 Hooks** 기준으로 다시 설계한다. 문서 API는 `host/` 어댑터 뒤로 격리한다 | §2.2 |
| 2 | 기본 모델이나 세션 모델을 자동으로 교체한다 | 💡 **가상 라우터 모델 `oamp/auto` 등**: 사용자가 이 모델을 고를 때만 자동 라우팅한다. 다른 모델을 고르면 OAMP는 개입하지 않는다 | §3 |
| 3 | 요청 실패 시 즉시 다른 모델로 전환할 수 있는지 미정 | 💡 라우터 `LanguageModelV3.doStream` 안에서 **첫 콘텐츠 청크 전(pre-commit)** 실패는 같은 요청 안에서 다음 경로로 전환한다. 첫 청크 이후 실패는 전파만 한다 | §6 |
| 4 | Coding/Agentic 점수의 주 출처를 AA 지수로 둠 | AA 무료 API는 `coding_index`·`agentic_index`가 **항상 null**이다. C/A는 OpenRouter 자체 평가, 전문 스냅샷, OAMP 자체 평가, 실사용 결과로 구성한다 | §2.3, §5 |
| 5 | `allowUnknownPrice=false`면 비용 정보 없는 모델 제외 | 이 규칙이면 xkiro·exaone이 **전부 제외**된다. 가격 상태 4단계와 사용자 선언(`freeDeclared`)을 도입한다 | §7 |
| 6 | 실측 데이터 0에서 시작 | `opencode.db`의 과거 assistant 메시지 2,443건으로 지연·오류 **사전값(prior)을 부트스트랩**한다 | §2.4 |
| 7 | Health는 필터로만 사용 | 💡 Circuit Breaker 필터에 더해 **가용성 배수 `H`**를 제안한다(FMR 공식 변경이므로 승인 필요) | §5.5 |
| 8 | 명령 등록 위치 미정 | OpenCode Command는 프롬프트 템플릿이다. 결정적 조회는 **`oamp` CLI(SQLite 직접 조회)**, 대화 내 조회는 **플러그인 Tool**로 한다 | §9 |

---

## 1. 목표와 범위 (v1.0 유지, 보완 사항만)

v1.0 §1의 핵심 요구사항 1~9와 초기 범위를 그대로 따른다. 보완 사항은 다음과 같다.

- **수동 선택 우선**은 "가상 모델을 고르지 않으면 OAMP가 개입하지 않는다"는 구조로 보장한다. 사용자 선택을 감지해서 피하는 방식이 아니다.
- **세션 일관성**: 세션마다 경로를 고정(sticky)한다. 사용자 턴 경계나 장애가 있을 때만 다시 평가한다(프롬프트 캐시 보존 목적도 있음).
- **유료 차단**: 라우터가 직접 하위 경로를 호출하므로 OpenCode의 비용 집계가 실제 경로와 어긋날 수 있다. 따라서 라우터 풀은 기본값으로 **무료 확인 경로만** 포함한다.

---

## 2. 사전 조사 결과 (2026-11-10)

### 2.1 운영 환경

| 항목 | 결과 |
|---|---|
| OpenCode | ✅ `~/.opencode/bin/opencode` 1.19.5 |
| 플러그인 패키지 | ✅ `~/.config/opencode/node_modules/@opencode-ai/plugin` 1.19.3. npm 1.19.5와 `dist/` 차이 없음 |
| 기존 로컬 플러그인 | ✅ `~/.config/opencode/plugins/orca-opencode-status.js` (V1 함수형 export, 자동 발견) |
| 설정 상태 | ⚠ **현재 설정이 깨져 있다.** `opencode models` 실행 시 `bad file reference: "{file:/home/ubuntu/.config/opencode/exaone-api-key}" ... does not exist`. 이 상태에서는 OpenCode CLI 전체와 Orca OpenCode worker가 실패할 수 있다 |
| models.dev 캐시 | ✅ `~/.cache/opencode/models.json`. `opencode` 137개(무료 51), `openrouter` 375개(무료 16, cost 없음 4), `nvidia` 52개(전부 cost 0). `xkiro`·`exaone`은 없음 |
| `canonical_model_id` | ✅ models.dev의 `opencode`·`nvidia` 항목에 있음. `openrouter` 항목에는 없음 → Identity 1차 출처로 사용 |
| 카탈로그 갱신 CLI | ✅ `opencode models --refresh`, `--verbose`(비용 포함) |
| 공급자 필터 | ✅ 설정 스키마에 `whitelist`/`blacklist`가 있다(바이너리 확인). 공식 models 문서에는 없다 |

### 2.2 플러그인 API 실체 (v1.0 §9.3 정정)

**V2 promise API (`@opencode-ai/plugin/v2/promise`)** ✅ 타입 확인

```ts
define({ id: string, setup(ctx: PluginContext) })
ctx.options                                   // 설정 options
ctx.catalog.transform(cb(draft)) / reload()   // provider.list/get/update/remove, model.get/update/remove, model.default.get/set
ctx.agent.transform(cb(draft)) / reload()     // list/get/default/update/remove (agent의 모델 지정 가능)
ctx.aisdk.sdk(cb({model, package, options, sdk?}))           // 공급자 SDK 인스턴스 생성 가로채기
ctx.aisdk.language(cb({model, sdk, options, language?}))     // LanguageModelV3 인스턴스 교체 ← 핵심
ctx.integration.connection.active(id) / resolve(conn)        // 공식 자격증명 조회
ctx.command / reference / skill .transform
```

- `ModelV2Info`: `capabilities{tools,input,output}`, `cost[]{input,output,cache}`, `limit`, `status(alpha|beta|deprecated|active)`, `variants`, `api` ✅
- 바이너리 내장 공급자(azure, bedrock, gitlab 등)가 바로 이 `catalog.transform`/`aisdk.language`로 구현되어 있다 ✅ → 안정적인 확장점으로 판단한다.

**V1 Hooks (`@opencode-ai/plugin` 기본 export)** ✅ 타입 확인

`event`, `config`, `tool`, `provider.models`, `chat.message`, `chat.params`, `chat.headers`, `tool.execute.before/after`, `experimental.*`. **retry hook과 http hook은 없다.**

**공식 문서(opencode.ai/docs/build/plugins/server)의 API**: `import { Plugin } from "@opencode/plugin"`, `ctx.model.*`, `ctx.session.hook("context"|"model.request"|"prompt"|...)`, 설정 키 `plugins`.
→ 현재 npm 패키지와 바이너리에 해당 import 경로가 없다(`@opencode/plugin` 문자열 0건). **향후 버전 API로 판단**하고 `host/docs-v2.ts` 어댑터 자리만 남긴다. ⚠
- 세션 모델 전환 HTTP API는 ✅ 있다: `POST /api/session/{sessionID}/model` (SDK v2 `switchModel`, "subsequent provider turns"). 보조 기능으로만 쓴다.
- 문서: "진행 중인 요청은 시작 시 설정을 유지한다" → 요청 도중 모델 교체는 공식 경로가 없다. 그래서 라우터 내부 전환(§6)을 쓴다.

### 2.3 벤치마크 API 실체 (v1.0 §4.1 정정)

| 출처 | 확인 내용 |
|---|---|
| OpenRouter `GET /api/v1/benchmarks` | ✅ Bearer(일반 OR 키), 분당 30회·일 500회. `source=artificial-analysis\|design-arena\|openrouter`, `task_type=coding\|intelligence\|agentic\|search`. AA 항목: `model_permaslug`, `intelligence_index`, `coding_index`, `agentic_index`, `pricing`. OR 자체 평가: `benchmark_type`(`gpqa_diamond`, `tau_bench_verified_airline`, search 계열), `accuracy`, `accuracy_stddev`, `total_tasks`, `last_run_timestamp`. `meta.as_of`, `meta.citation`(재게시 시 필수 표기), `meta.version=v1` |
| AA `GET /api/v2/language/models/free` | ✅ `x-api-key`, 첫 요청부터 24시간 고정 윈도 100회. `X-RateLimit-*`, `Retry-After`. 필드: `slug`, `model_creator`, `evaluations.artificial_analysis_intelligence_index`, `pricing.price_1m_*`, `performance.median_output_tokens_per_second`, `median_time_to_first_token_seconds`, `median_time_to_first_answer_token_seconds`, `median_end_to_end_response_time_seconds`. **`coding_index`·`agentic_index`는 항상 null**(공식 문서 명시). 표시할 때 출처 표기 필수 |
| 공급자별 속도 | 두 API 모두 무료 등급에서는 **모델 단위 중앙값만** 제공한다(AA 공급자별 데이터는 Commercial). → 경로별 속도는 **OAMP 실측만** 쓴다 |
| 모델 ID 매핑 | OR `model_permaslug` ↔ OpenCode `openrouter/<id>`는 직접 대응된다. AA `slug`(예: `glm-5-3`) ↔ 기타 경로는 Identity 매핑이 필요하다(AA Pro에는 `openrouter_api_id`가 있으나 무료 등급에는 없다) |

> 결론: 무료 출처에서 바로 얻을 수 있는 값은 **I(AA·OR intelligence)**, **A의 일부(OR `tau_bench_verified_airline`)**, **모델 단위 속도 사전값(AA)**이다. **C(코딩)는 무료 API로는 사실상 공백**이다. 전문 스냅샷(SWE-bench Pro, LiveCodeBench 등)은 무료·소형 모델 커버리지가 낮을 것으로 예상하므로(⚠ 수집 시 확인), 자체 평가를 Phase 5에서 **Phase 2로 앞당긴다**.

### 2.4 과거 실사용 데이터 (부트스트랩 사전값)

`~/.local/share/opencode/opencode.db`의 `message.data`(assistant)에는 `providerID`, `modelID`, `tokens{input,output,reasoning,cache}`, `time{created,completed}`, `finish`, `error{name,data.statusCode}`가 있다 ✅. 집계 결과(읽기 전용 조회, E2E = completed − created, TPS = (output+reasoning)/E2E, 근사치):

| 경로 | n | 오류 | E2E p50(s) | TPS p50 | 주요 오류 |
|---|---:|---:|---:|---:|---|
| opencode/deepseek-v4.1-flash-free | 916 | 2 | 7.3 | 50.8 | 사용자 중단 |
| openrouter/cohere/north-mini-code:free | 472 | 2 | 3.3 | 50.3 | 400 1건 |
| openrouter/thinkingmachines/inkling:free | 412 | 1 | 8.7 | 17.9 | — (현재 카탈로그에서 제거됨) |
| nvidia/z-ai/glm-5.3-flash | 155 | 1 | 25.7 | 27.3 | — |
| openrouter/openrouter/free | 135 | 2 | 8.5 | 25.6 | 429 |
| opencode/glm-5.3-flash-free | 110 | 1 | 10.7 | 44.0 | — |
| opencode/nemotron-3-ultra-free | 60 | 3 | 7.7 | 15.5 | 사용자 중단 |
| xkiro/qwen/qwen3.5-397b-a17b:free | 28 | 0 | 6.0 | 15.2 | — |
| openrouter/z-ai/glm-5.3-flash (유료) | 4 | 2 | — | — | **403** |
| openrouter/nvidia/nemotron-3-super-120b-a12b:free | 2 | 2 | — | — | **404** |
| openrouter/google/gemma-4-31b-it:free | 2 | 2 | — | — | **429** |

시사점:
- `MessageAbortedError`는 사용자 중단이다 → **장애로 집계하지 않는다**.
- 403(유료·권한), 404(경로 폐지), 429(무료 한도)가 실제 장애 유형이다 → §6.2 분류에 반영한다.
- 같은 기반 모델이라도 경로별 차이가 크다(glm-5.3-flash: opencode 10.7s vs nvidia 25.7s) → v1.0의 "경로별 분리" 원칙을 데이터로 확인했다.
- 메시지에 기록되는 것은 최종 결과뿐이다. OpenCode 내부 재시도로 흡수된 429는 빠져 있다 → 실측 계측은 라우터 내부에서 한다.

---

## 3. 💡 핵심 설계: 가상 라우터 모델

### 3.1 개념

OAMP는 **가상 공급자 `oamp`**와 풀 단위 가상 모델을 등록한다.

| 가상 모델 | 풀 | 가중치 프로필 |
|---|---|---|
| `oamp/auto` | 기본 | FMR 기본(C55/A30/I15, P70/L30) |
| `oamp/coding` | 코딩 | C 비중 상향(향후) |
| `oamp/agentic` | 에이전트 | A 비중 상향(향후) |
| `oamp/fast` | 보조 요청·빠른 응답 | L 비중 상향(향후) |

- 사용자가 `oamp/*`를 고르면(TUI `/models`, `opencode run --model oamp/auto`, agent 설정 등) 그 요청은 OAMP 라우터가 처리한다.
- 다른 모델을 고르면 OAMP는 **텔레메트리만 수집하고 선택에는 개입하지 않는다**. 이것으로 v1.0의 "수동 선택 우선"과 "자동 라우터가 선택을 덮어쓰지 않음"을 구조적으로 충족한다.
- Phase 1부터는 v1.0의 순위 기반 출력 대상을 이 풀의 후보 순서로 정의한다.

### 3.2 동작 흐름

```text
OpenCode agent loop
  └─ streamText(model = oamp/auto)
       └─ [aisdk.language hook] → OampRouterModel (LanguageModelV3)
            doStream(options):
              1. 헤더에서 sessionID·agent·요청 종류 추출 (chat.headers hook이 주입)
              2. Router.select(pool, session, 요청 특성) → 후보 경로 목록 [r1, r2, ...]
              3. r1.doStream(변환된 options) → 첫 콘텐츠 청크까지 감시
                   실패(pre-commit) → 분류·기록 → r2 ...  (최대 4경로/30초)
                   성공 → commit, 나머지 스트림 전달하며 TTFT/TTFA/E2E/TPS 측정
              4. finish → telemetry 기록, 세션 sticky 갱신
```

### 3.3 하위 경로 LanguageModel 획득 방법 (Phase 0에서 확정)

| 방안 | 내용 | 장점 | 위험 |
|---|---|---|---|
| **A (우선)** | V2 `catalog.transform`에서 공급자 `api.package`·`api.url`·모델 `api.id`를 읽고, `integration.connection.active/resolve`로 자격증명을 얻어 `@ai-sdk/openai-compatible` 등으로 직접 생성한다 | 공식 자격증명 API를 쓴다. 디스크에 키를 저장하지 않는다 | ⚠ `{file:...}`로 설정한 config 키가 connection으로 노출되는지 미확인 |
| B | `aisdk.sdk` hook에서 OpenCode가 만든 공급자 SDK를 메모리에 캐시하고 재사용한다 | OpenCode가 만든 SDK를 그대로 쓴다 | 사용한 적 없는 공급자는 SDK가 지연 생성되어 캐시가 비어 있을 수 있다 |
| C (최후) | V2 외부 플러그인이 로드되지 않으면 `oamp` 공급자의 `npm`을 `file://` 로컬 AI SDK provider 패키지로 지정한다 | V1 환경에서도 동작한다 | 자격증명을 직접 읽어야 한다 → 보안 검토가 필요하므로 기본 채택하지 않는다 |

- 자격증명은 **프로세스 메모리에만 둔다**. SQLite·로그·오류 메시지에 기록하지 않는다(로그 마스킹 테스트 포함).
- 초기 범위는 OpenAI 호환 프로토콜 경로(xkiro, exaone, openrouter, nvidia, opencode zen의 OpenAI 호환 모델)로 한정한다. 다른 SDK 패키지를 쓰는 경로는 Phase 4 이후에 다룬다.

### 3.4 가상 모델 메타데이터

- `capabilities.tools = true`. 풀은 tool calling 지원 경로만 포함한다.
- `limit.context`: 풀 후보의 컨텍스트 하한값 또는 설정값(기본 128k) 중 작은 값. OpenCode의 compaction 판단이 이 값을 따른다.
- `limit.output`: 후보 하한값.
- `cost = 0`(무료 전용 풀). 유료 허용 시 OpenCode 측 비용 표시는 부정확해지므로 OAMP 자체 집계(`oamp stats`)를 정식 비용 기록으로 쓴다.
- 등록 방법: `catalog.transform`에서 가상 공급자를 생성할 수 있는지 ⚠ 확인한다. 불가하면 `opencode.jsonc`에 `provider.oamp`를 정의하고 `aisdk.language`에서 교체한다.

### 3.5 세션 고정과 요청 종류

- `chat.headers` hook(V1)에서 `x-oamp-session`, `x-oamp-agent`, `x-oamp-message`를 주입한다. 라우터는 이 값을 읽은 뒤 **하위 경로로 보내기 전에 제거**한다. ⚠ 헤더가 `doStream(options.headers)`까지 도달하는지 E6에서 확인한다.
- `agent`가 `title`·`compaction`·`summary` 등 보조 에이전트면 `fast` 풀 정책을 적용한다(v1.0 §7.1의 primary·보조 구분).
- 세션 sticky 규칙: 같은 세션에서는 직전 성공 경로를 유지한다. 다음 경우에만 다시 선택한다.
  1. 현재 경로가 Cooldown이나 Circuit Open 상태가 된 경우
  2. 새 사용자 메시지(`chat.message`) 시점에 최상위 후보와의 점수 차가 `switchMargin`(기본 5점) 이상이고 그 상태가 `switchHoldMinutes`(기본 30분) 이상 지속된 경우
  3. 입력 크기가 현재 경로의 컨텍스트 한도를 초과한 경우

---

## 4. 모듈 구성과 저장소 구조

```text
opencode-adaptive-model-pool/
  package.json            # bun + TypeScript, @opencode-ai/plugin 버전 고정
  src/
    index.ts              # 플러그인 진입점 (V2 define + V1 hooks shim)
    host/                 # OpenCode 연동 경계 (버전 의존 코드는 여기에만)
      v2-promise.ts       #   catalog/aisdk/agent/integration
      v1-hooks.ts         #   chat.headers, chat.message, event, tool
      docs-v2.ts          #   (향후) ctx.model/ctx.session API
    router/               # OampRouterModel(LanguageModelV3), pre-commit failover, 스트림 계측
    discovery/            # 카탈로그 동기화, 신규/stale/폐지 상태 전이
    identity/             # canonical / variant / route ID, 매핑 신뢰도
    benchmarks/           # openrouter.ts, artificial-analysis.ts, snapshots/, selfeval/
    telemetry/            # 요청 계측, 버킷 집계, EWMA, p50/p95, opencode.db 부트스트랩
    scoring/              # P, L, c, H, R 계산 (순수 함수)
    health/               # 오류 분류, Cooldown, Circuit Breaker, 복구 Probe
    policy/               # 가격 상태, 허용/차단, 풀 정의
    storage/              # bun:sqlite, schema.sql, migrations/, lease
    cli/                  # oamp status/rank/model/refresh/probe/history/stats
  test/
    fakes/fake-language-model.ts   # 지연·오류·부분 스트림 주입
  docs/
```

- `scoring/`, `health/`, `policy/`, `identity/`는 **순수 함수 모듈**로 만들고 OpenCode 의존성을 두지 않는다 → 단위 테스트 대상.
- 버전 의존 코드는 `host/`에만 둔다. OpenCode가 문서상 API(`ctx.model`, `ctx.session.hook`)로 바뀌면 어댑터만 교체한다.

---

## 5. 점수 모델 (v1.0 §6~8 구체화)

### 5.1 지표 → 상위 점수 매핑 (데이터 가용성 반영)

| 상위 | 지표(분류 내부 가중치 초안) | 출처 | 비고 |
|---|---|---|---|
| **C** Coding | OAMP 자체 코딩 평가 40 / SWE-bench Pro 25 / LiveCodeBench 15 / OpenCode 실사용 작업 성공률 20 | selfeval, 스냅샷, telemetry | 실사용 성공률은 표본 30건 이상일 때만 반영 |
| **A** Agentic | OAMP 자체 tool-call 평가 35 / OR `tau_bench_verified_airline` 25 / Terminal-Bench 25 / MCP Atlas·BFCL 15 | selfeval, OR, 스냅샷 | |
| **I** Reasoning | AA `intelligence_index` 60 / OR `gpqa_diamond` 25 / LiveBench 15 | AA, OR, 스냅샷 | OR이 재공급한 AA 지수는 AA와 같은 측정으로 보고 **하나만** 사용 |

- 결측 지표는 v1.0 원칙대로 제외하고 남은 가중치를 재정규화한다.
- 💡 **I → C 대리값**: C가 완전히 결측이고 I만 있으면 `C_proxy = I`로 두되 해당 항목의 신뢰도 기여는 0.3배로 한다(가설, Phase 5 상관 분석에서 검증 후 유지 여부 결정).
- 정규화: 각 지표를 **고정 기준 범위**(벤치마크·버전별 `ref_min`, `ref_max`. 초기값은 수집 시점 전체 모집단의 p5/p95로 산정해 저장하고 이후 고정)로 0~100 선형 환산한다. 버전이 바뀌면 새 시계열과 새 기준 범위를 쓴다.

### 5.2 신뢰도 `c` (v1.0 §6.3 구체화)

```text
c = coverage × match × recency × independence
coverage    = Σ(존재하는 지표의 상위 가중치 × 분류 내부 가중치)      ∈ [0,1]
match       = Identity 매핑 신뢰도: 정확 일치/수동 매핑 1.0, 정규화 일치 0.8, 대리값 0.3
recency     = 0.5 ^ (경과일 / 180)
independence= 독립 출처 1개 0.7, 2개 이상 1.0
P_eff = c·P + (1−c)·50
```

### 5.3 속도 점수 `L`

- 지표 정의는 v1.0 §7.1을 따르고 라우터 스트림에서 측정한다.
  - **TTFT**: `doStream` 호출부터 첫 스트림 파트(`text-delta`, `reasoning-delta`, `tool-input-start`)까지
  - **TTFA**: 첫 `text-delta` 또는 `tool-input-start`까지(reasoning 제외)
  - **E2E**: `finish`까지
  - **TPS**: 출력 토큰 / (E2E − TTFT)
- 환산: `S = 100 × clamp((ln ref_max − ln x) / (ln ref_max − ln ref_min), 0, 1)`(TPS는 방향 반대). 버킷은 입력 토큰 구간 `0–2k / 2–16k / 16–64k / 64k+` × 요청 종류(primary/보조)로 나눈다.
- 초기 `ref_min/ref_max`는 §2.4 부트스트랩 분포의 p10/p90으로 정해 저장하고 고정한다.
- 표본 축소(shrinkage): `L_route = (n·L_obs + n0·L_prior) / (n + n0)`, `n0 = 10`. `L_prior` 우선순위: 같은 경로 과거 데이터(opencode.db) → AA 모델 중앙값 → 중립 50.
- EWMA `α = 0.25`를 쓰고 p50/p95는 최근 200건 링버퍼로 계산한다.

### 5.4 최종 점수

```text
R = 0.70·P_eff + 0.30·L          (v1.0 유지)
```

### 5.5 💡 가용성 배수 `H` (승인 필요)

무료 경로의 실제 장애는 429·403·404가 대부분이다(§2.4). 필터만 쓰면 Cooldown이 풀린 직후 같은 경로가 다시 최상위로 올라와 실패를 반복한다. 다음을 제안한다.

```text
H = clamp(success_ewma, 0.5, 1.0) ^ 2      (사용자 중단은 제외, 최근 50건 기준)
R_final = R × H
```

- 승인하지 않으면 `H = 1`로 두고 v1.0 공식만 쓴다(설정 `weights.availabilityPenalty: false`).

### 5.6 선택 절차 (v1.0 §8 구체화)

1. 풀 후보 = 활성 카탈로그 ∩ 정책 허용 ∩ `capabilities.tools` ∩ 컨텍스트 한도 ≥ 추정 입력 토큰 × 1.2
2. Health 상태가 `cooldown`·`open`·`disabled`인 경로 제외
3. `R_final` 계산 → 내림차순
4. 동점(±1점): 최근 p95 E2E가 낮은 쪽 → 실패율이 낮은 쪽 → 직전 선택과 다른 공급자
5. 탐색: 확률 `explorationBudget`(5%)로 `probation` 상태 경로 하나를 1순위에 둔다. 단 **보조 요청과 사용자 첫 턴에만** 적용하고, 실패 시 즉시 정상 후보로 failover한다
6. 선택 결과, 후보 상위 4개 점수, 사유 코드를 `rank_history`에 기록한다

---

## 6. 장애 대응과 Failover (v1.0 §9 구체화)

### 6.1 Pre-commit 상태기계

```text
[select] → [attempt r_i] ──(스트림 시작 전 throw)──────────┐
              │                                           │
              ├─(첫 콘텐츠 파트 전 error 파트/타임아웃)──────┤→ classify → 재시도 가능 && 예산 남음 → [attempt r_i+1]
              │                                           │                      └ 아니면 → 마지막 오류를 그대로 throw
              └─(첫 콘텐츠 파트 수신) → [committed] → 스트림 전달
                                              └─(이후 오류) → 기록 후 전파 (재실행 안 함)
```

- **콘텐츠 파트**: `text-delta`, `reasoning-delta`, `tool-input-start`, `tool-call`. `stream-start`·`response-metadata`는 버퍼링하고 commit 시 함께 전달한다.
- Pre-commit 구간에는 아직 OpenCode에 아무 출력도 전달되지 않았고 도구도 실행되지 않았다. 그래서 다른 경로로 재요청해도 중복 부작용이 없다.
- Commit 이후에는 AI SDK가 `tool-call` 파트를 받는 즉시 도구를 실행할 수 있으므로 **절대 재실행하지 않는다**. 오류를 OpenCode에 전파하면 OpenCode 자체 재시도가 동작하고, 그 재시도는 다시 라우터를 거치며 Cooldown 경로를 제외한 후보로 간다.
- 첫 콘텐츠 대기 타임아웃 `firstTokenTimeoutMs`: 기본 45초, 보조 요청 20초. 과거 nvidia p50 E2E가 25.7초였으므로 경로별 p95 × 1.5와 기본값 중 큰 값을 쓴다.
- 예산: 요청당 최대 4경로, failover 누적 30초(v1.0 유지). 시도한 경로 집합을 유지해 순환을 막는다.
- **abort 신호**(`options.abortSignal`)는 하위 요청에 그대로 전달한다. 사용자 중단은 장애가 아니며 failover하지 않는다.

### 6.2 오류 분류 (실데이터 반영)

| 분류 | 판정 | 처리 |
|---|---|---|
| `rate_limit` | 429 | `Retry-After` 우선, 없으면 60s→120s→300s 지수 Cooldown. 같은 요청 안에서 failover |
| `server` | 5xx, 연결 오류 | 경로 연속 3회 실패 시 Circuit Open(120s). 같은 요청 안에서 failover |
| `timeout` | 첫 콘텐츠 타임아웃 | `server`와 같게 처리 |
| `auth` | 401 | 공급자 단위 `disabled`, 자동 복구 Probe 중단, 사용자 알림 |
| `forbidden` | 403 | 경로 `disabled`(유료·권한 문제 가능). 일 1회 Probe만 수행 |
| `not_found` | 404, "model not found" | 경로 `stale` → 카탈로그 재확인 후 폐지 처리 |
| `bad_request` | 400(컨텍스트 초과 제외) | 해당 경로 × 기능 조합 제외. 같은 요청 failover는 **1회만** 허용(요청 자체 문제일 수 있음) |
| `context_overflow` | 400 + context 관련 메시지 | 더 큰 컨텍스트 후보로 failover. 없으면 전파(OpenCode compaction에 맡김) |
| `aborted` | abortSignal, `MessageAbortedError` | 장애로 집계하지 않음 |
| `post_commit` | commit 이후 오류 | 기록·전파만 함. 재실행 안 함 |

### 6.3 복구

- Cooldown이 끝나면 경로를 `probation`으로 둔다. 다음 중 하나로 1회 검증한다: 탐색 슬롯의 실제 보조 요청, 또는 일 비용 한도 안의 최소 Probe(`max_tokens=16`, tool 1개짜리 고정 프롬프트). 성공하면 `healthy`로 되돌린다.
- Probe 결과는 `request_metrics.kind = 'probe'`로 분리 저장한다(v1.0 §7.3).

---

## 7. 가격·사용 정책 (v1.0 §11 정정)

| 가격 상태 | 판정 규칙 | `allowPaid=false`에서 |
|---|---|---|
| `free_verified` | 카탈로그 cost input=output=0 **이고** (ID에 `:free`/`-free`가 있음 **또는** 공급자가 무료 공급자로 등록됨) | 허용 |
| `free_quota` | cost 0이지만 크레딧·쿼터 기반 공급자(nvidia) | 허용, 쿼터 소진 오류(429/403)를 `rate_limit`으로 처리 |
| `free_declared` | 카탈로그에 비용 정보가 없고 사용자가 설정 `freeDeclared` 패턴으로 무료라고 선언 | 허용 |
| `paid` | cost > 0, 또는 ID에 무료 표식이 없는 OR 모델 | 차단 |
| `unknown` | 그 외 | `allowUnknownPrice=true`일 때만 허용 |

- 현재 설정에 바로 적용하면 다음과 같다.
  - xkiro: 26개 모델 모두 비용 정보 없음 → 기본값에서는 `unknown`이므로 제외된다. `freeDeclared: ["xkiro/*:free"]` 같은 선언이 필요하다(**사용자 결정**).
  - openrouter whitelist의 `z-ai/glm-5.3-flash`, `google/lyria-*`(무료 표식 없음) → `paid`로 차단된다. 실제로 과거 403이 발생했다.
  - exaone: 등록 모델이 `throw` 1개뿐이고 키 파일이 없다 → 정상화 전에는 `disabled`.
- **모달리티 필터**: 이미지·음성·임베딩·안전성 분류 모델(flux, whisper, rerank, content-safety 등)은 `capabilities.output`에 text가 없거나 tools=false이므로 자동 제외한다.

---

## 8. 저장소 (v1.0 §5.2, §10 구체화)

- 엔진: `bun:sqlite` ⚠(OpenCode 런타임에서 사용 가능한지 E8로 확인. 불가하면 `node:sqlite` → 순수 JSON 스냅샷 순으로 대체)
- 경로: `~/.local/share/oamp/oamp.db`, WAL, `busy_timeout=5000`
- **다중 프로세스**: Orca worker 여러 개가 OpenCode를 동시에 실행한다. 외부 API 수집(특히 AA 일 100회)은 `leases` 테이블의 `(job, holder, expires_at)` 리스를 얻은 프로세스만 수행한다.
- 텔레메트리는 메모리 버퍼에 모았다가 1초 또는 20건 단위로 배치 기록한다.

```sql
-- 핵심 테이블 (전체 DDL은 storage/schema.sql)
models(canonical_id PK, family, released_at, capabilities_json, updated_at)
model_aliases(source, source_id, canonical_id, variant_id, match_conf, PRIMARY KEY(source, source_id))
routes(route_id PK, provider_id, model_id, variant, endpoint_fp, price_state, ctx_limit, out_limit,
       tools, status CHECK(status IN ('active','stale','retired','disabled')), first_seen, last_seen)
benchmarks(id PK, source, benchmark, version, harness, variant_id, effort, raw, normalized, ref_min, ref_max,
           evaluated_at, collected_at, citation)
request_metrics(id PK, ts, route_id, session_hash, kind CHECK(kind IN ('primary','aux','probe','selfeval')),
                in_bucket, ttft_ms, ttfa_ms, e2e_ms, out_tokens, tps, outcome, error_class, attempt_no)
route_stats(route_id, bucket, kind, n, ewma_ttfa, ewma_e2e, ewma_tps, p50_e2e, p95_e2e, success_ewma, updated_at)
health_states(route_id PK, state, error_class, consecutive_fail, cooldown_until, last_error_at, last_ok_at)
scores(route_id, pool, p, p_eff, c, l, h, r, computed_at)
rank_history(id PK, ts, pool, session_hash, chosen_route, top4_json, reason)
leases(job PK, holder, expires_at)
schema_version(v)
```

- 세션 ID는 **해시로만** 저장한다. 프롬프트, 응답 본문, 헤더, 자격증명은 저장하지 않는다(v1.0 유지).
- opencode.db는 **읽기 전용**(`mode=ro`)으로만 연다. 부트스트랩과 실패 메시지 대조에만 사용한다.

---

## 9. 명령·조회 인터페이스 (v1.0 §11 구체화)

| 형태 | 내용 |
|---|---|
| `oamp` CLI (`bun run cli/index.ts`) | `status`, `rank [pool]`, `model <route>`, `refresh`, `probe [route]`, `history`, `stats`, `pin <route> --session`, `unpin`. SQLite를 직접 조회하므로 LLM을 거치지 않는다 |
| 플러그인 Tool (V1 `tool` hook) | `oamp_status`, `oamp_rank`: 대화 중 모델이 호출할 수 있는 읽기 전용 도구 |
| OpenCode Command | `/oamp-rank` 등은 위 Tool 호출을 지시하는 프롬프트 템플릿으로만 제공한다 |

- `pin`은 가상 모델을 쓰는 세션 안에서 경로를 고정한다. 모델 자체를 고정하려면 OpenCode에서 실제 모델을 직접 고르면 된다(§3.1).
- 화면에 표시할 때 AA·OR `meta.citation` 출처 표기를 붙인다.

---

## 10. 설정 스키마 v1.1

```jsonc
{
  "plugin": [   // ⚠ 1.19.5는 V1 키 "plugin". 문서상 V2 키 "plugins"는 E1에서 확인
    ["file:///home/ubuntu/orca/projects/opencode-adaptive-model-pool/src/index.ts", {
      "enabled": true,
      "pools": {
        "auto":    { "providers": ["opencode", "openrouter", "nvidia", "xkiro", "exaone"] },
        "fast":    { "inherit": "auto", "weights": { "performance": 0.4, "latency": 0.6 } }
      },
      "policy": {
        "allowPaid": false,
        "allowUnknownPrice": false,
        "freeDeclared": [],                 // 예: ["xkiro/*:free"]  ← 사용자 결정
        "deny": [],                         // route glob
        "requireToolCalling": true,
        "maxRoutesPerRequest": 4,
        "failoverBudgetMs": 30000,
        "firstTokenTimeoutMs": 45000,
        "auxFirstTokenTimeoutMs": 20000,
        "explorationBudget": 0.05,
        "switchMargin": 5,
        "switchHoldMinutes": 30
      },
      "weights": {
        "performance": 0.70, "latency": 0.30,
        "coding": 0.55, "agentic": 0.30, "reasoning": 0.15,
        "availabilityPenalty": true         // §5.5, 승인 필요
      },
      "latency": { "ttfa": 0.35, "e2e": 0.45, "tps": 0.20, "ewmaAlpha": 0.25, "priorWeight": 10 },
      "benchmarks": {
        "openrouter": { "enabled": true, "credential": "integration:openrouter" },   // 기존 OR 연결 재사용
        "artificialAnalysis": { "enabled": false, "keyFile": "~/.config/oamp/aa-key" } // 키 발급 시 활성화
      },
      "refresh": { "catalogHours": 6, "benchmarkHours": 24, "snapshotDays": 7 },
      "storage": { "path": "~/.local/share/oamp/oamp.db" }
    }]
  ],
  "provider": {
    "oamp": {                               // §3.4: catalog.transform 등록이 불가할 때만 사용
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://oamp.invalid/v1" },  // 실제 호출은 aisdk.language가 교체
      "models": { "auto": {}, "fast": {} }
    }
  }
}
```

- 자격증명 값은 설정에 넣지 않는다. 기존 OpenCode 연결(`integration`)을 재사용하거나 0600 파일 참조만 쓴다.
- 사용자의 기존 `provider`, `whitelist`, 인증 설정은 **변경하지 않는다**(v1.0 범위 유지). 설치와 제거는 `plugin` 항목과 `provider.oamp` 블록만 추가·삭제하면 된다.

---

## 11. Phase 0 — 실현성 실험 (구체화)

각 실험은 격리 설정(`OPENCODE_CONFIG`로 별도 jsonc 지정, 기존 설정 무변경)에서 수행하고 결과를 `docs/compatibility.md`에 기록한다.

| ID | 실험 | 통과 기준 | 실패 시 |
|---|---|---|---|
| E0 | 설정 정상화 확인(exaone 키 파일) | `opencode models` 정상 출력 | **사용자 조치 필요**. 격리 설정에서 exaone을 빼고 진행 |
| E1 | 외부 플러그인에서 V2 `define({id,setup})` 로드 여부, 설정 키(`plugin`/`plugins`), V1 함수형과 공존 | `setup`이 호출되고 `ctx.catalog`에 접근 가능 | V1 전용으로 진행하고 §3.3 방안 C 검토 |
| E2 | `catalog.transform`으로 활성 카탈로그 읽기 + 가상 공급자/모델 생성 | `oamp/auto`가 `/models`에 노출 | `provider.oamp`를 config에 정의 |
| E3 | `aisdk.language`에서 `oamp/auto`에 대해 커스텀 LanguageModelV3 반환 | 일반 대화와 tool call 1회가 정상 동작 | 방안 C |
| E4 | 하위 경로 생성: `integration.connection.resolve` + openai-compatible로 opencode/openrouter/nvidia/xkiro 각 1회 호출 | 4개 공급자 성공, 키가 로그에 남지 않음 | 방안 B(aisdk.sdk 캐시) |
| E5 | Pre-commit failover: 1순위에 429를 내는 가짜 모델 → 2순위 성공 | OpenCode 세션에 오류 없이 2순위 응답이 표시되고, 메시지가 1건만 남음 | 다음 요청부터 전환하는 방식으로 축소 |
| E6 | `chat.headers`로 넣은 헤더가 `doStream(options.headers)`에 도달 | 세션 ID 수신 | `chat.params`의 `options`로 전달하거나 sticky를 프로세스 단위로 축소 |
| E7 | OpenCode 자체 재시도 정책 관찰(429·5xx·타임아웃) | 재시도 횟수와 지연 파악 | 라우터 예산을 그에 맞게 조정 |
| E8 | `bun:sqlite` 사용, 2개 프로세스 동시 기록(WAL) | 손상·락 오류 없음 | `node:sqlite` → JSON |
| E9 | V1 `event`로 `message.updated` 수신(실제 모델 사용 시 수동 텔레메트리) | 직접 선택 모델의 E2E·토큰 수집 | opencode.db 주기 조회로 대체 |
| E10 | `POST /api/session/{id}/model` 동작(보조 기능) | 다음 턴 모델 변경 | 기능 제외 |

**산출물**: `docs/compatibility.md`, 최소 PoC(`oamp/auto` → 고정 2경로 failover), 방안 A/B/C 확정.
**Go/No-go**: E1·E3 둘 다 실패하면 아키텍처를 재검토하고 사용자에게 보고한다.

---

## 12. 단계별 작업 (v1.0 §12 재배열)

| Phase | 내용 | 산출물 | 완료 기준 |
|---|---|---|---|
| 0 | §11 실험 | compatibility.md, PoC | E1~E6 판정 완료 |
| 1 | Discovery·Identity·Storage·Policy + opencode.db 부트스트랩 | 동적 Registry, `oamp status` | 5개 공급자 경로 등록, 가격 상태·모달리티 필터 테스트 통과 |
| 2 | Benchmark(OR·AA) + **자체 평가 최소 세트(앞당김)** + Performance Score | 경로별 P, c, 출처 이력 | 모든 활성 경로에 P_eff 산출, 출처 중복 없음 |
| 3 | Router 계측 + Latency Score + Dynamic Ranking + sticky | `oamp rank`, 실측 반영 순위 | 실측 누적에 따라 순위가 바뀌고, 근소한 변동에는 바뀌지 않음 |
| 4 | Health·Pre-commit Failover·Recovery | 장애 내성 라우터 | §13 장애 시나리오 테스트 통과 |
| 5 | 전문 스냅샷 어댑터·가중치 상관 분석·패키징 | 배포 패키지, 운영 문서 | 설치·제거 시 기존 설정 무변경 |

자체 평가 최소 세트(Phase 2)는 v1.0 §6.4의 1·3번(오류 수정 + 테스트 통과, 스키마 tool call)으로 시작한다. 경로당 과제 10개를 넘기지 않고, 무료 경로에서만 실행하며, 일일 실행 상한을 둔다.

---

## 13. 검증 기준 (v1.0 §13 + 추가)

v1.0 §13의 표를 유지하고 다음을 추가한다. 장애 시나리오는 `test/fakes/fake-language-model.ts`로 재현 가능해야 한다.

| 테스트 | 통과 조건 |
|---|---|
| Pre-commit failover | 1순위 429/5xx/타임아웃 → 같은 요청에서 2순위 응답, OpenCode 메시지 1건 |
| Post-commit 실패 | 재실행하지 않음, `post_commit`으로 기록, tool 실행 횟수 1회 |
| 사용자 중단 | failover 없음, 장애 집계 없음 |
| 403/404 처리 | `disabled`/`stale` 전이, 반복 호출 없음 |
| 가상 모델 미선택 | 직접 선택한 모델 요청에 라우터 코드가 개입하지 않음(텔레메트리만) |
| 가격 상태 | xkiro(비용 정보 없음)는 `freeDeclared` 없이는 제외, OR `:free` 없는 모델은 차단 |
| 자격증명 비노출 | DB·로그·오류 메시지 전수 검사에서 키 문자열 0건 |
| 다중 프로세스 | 프로세스 2개 동시 실행 시 외부 벤치마크 API 호출이 리스로 1회만 발생 |
| AA 한도 | 24시간 100회 중 실사용 ≤ 5회/일 |

---

## 14. 위험 요소

| 위험 | 영향 | 대응 |
|---|---|---|
| OpenCode 업데이트로 V2 API 변경(문서는 이미 다른 API를 설명함) | 플러그인 로드 실패 | `host/` 격리, 버전 고정, `opencode upgrade` 전 호환성 테스트 |
| 경로 간 `providerOptions` 비호환(reasoning 옵션 등) | 400 오류 | 경로별 옵션 변환기, 초기에는 OpenAI 호환 경로만 사용 |
| 가상 모델 비용·컨텍스트 메타데이터 부정확 | compaction 시점·비용 표시 오차 | 하한값 사용, OAMP 자체 통계를 정식 기록으로 사용 |
| 무료 모델의 벤치마크 커버리지 부족 | 순위가 속도 위주로 쏠림 | 자체 평가 앞당김, 대리값, 신뢰도 보정 |
| 프롬프트 캐시 손실 | 지연·비용 증가 | 세션 sticky, 턴 경계에서만 전환 |

---

## 15. 사용자 결정 필요 사항

1. **가상 라우터 모델 방식(§3) 채택**: 자동 라우팅은 `oamp/*`를 고를 때만 동작한다. v1.0의 "기본 모델 자동 교체"를 대체한다.
2. **exaone 키 파일 누락(§2.1)**: 현재 `opencode models`가 실패한다. 키 파일 복구 또는 exaone 공급자 제거가 필요하다(자격증명 작업이므로 Coordinator가 임의로 조치하지 않음).
3. **xkiro 무료 선언(§7)**: 비용 정보가 없는 xkiro `:free` 모델을 `freeDeclared`로 무료 취급할지.
4. **벤치마크 키**: OpenRouter Benchmarks에 기존 OpenRouter 연결을 재사용할지, AA 무료 키를 새로 발급할지.
5. **가용성 배수 `H`(§5.5)**: FMR 공식에 추가할지.

---

## 16. 참고 근거

- 로컬: `~/.config/opencode/node_modules/@opencode-ai/plugin/dist/{index.d.ts, v2/promise/*.d.ts, v2/effect/*.d.ts}`, `@opencode-ai/sdk@1.19.5 dist/v2/gen/{sdk.gen.d.ts,types.gen.d.ts}`, `~/.cache/opencode/models.json`, `~/.local/share/opencode/opencode.db`(읽기 전용), OpenCode 1.19.5 바이너리 문자열 검사
- 웹(2026-11-10 조회): opencode.ai/docs/build/plugins/server, /migrate-v1, /docs/models; openrouter.ai/docs/api/api-reference/benchmarks/get-benchmarks; artificialanalysis.ai/data-api/docs, /reference
- 전문 벤치마크 출처 목록은 v1.0 §15를 따르며, 각 리더보드의 최신 버전명은 Phase 5 수집 시점에 다시 확인한다
