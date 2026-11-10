# OpenCode Adaptive Model Pool (OAMP) 개발 계획 — 구체화본

- 버전: v1.3 (v1.2 + Phase 0 결과 반영, 이전본: `docs/plan-v1.2.md`·`plan-v1.1.md`, 원본: `docs/plan-v1.0.md`)
- Phase 0 결과 상세: `docs/compatibility.md`
- 작성일: 2026-11-10
- 기준 환경: GCE, OpenCode 바이너리 **1.19.5**, `@opencode-ai/plugin` 1.19.3 설치(npm 최신 1.19.5, V2 타입 동일)
- 표기: ✅ = 이번 조사에서 파일·명령·문서로 확인 / ⚠ = 미확인, Phase 0 실험으로 판정 / 💡 = 새로 제안한 설계

### v1.3 변경 (Phase 0 결과, 2026-11-10)

| 결과 | 반영 |
|---|---|
| E1 ❌ 외부 플러그인은 V2(`{id, setup}`)를 로드하지 못한다(`must default export an object with server()`) | **V1 hooks 전용**으로 확정. `catalog.transform`·`aisdk.*`·`integration.*`를 쓰는 설계를 모두 V1 대안으로 바꾼다 |
| E3 ✅ `chat.message` 모델 교체가 Zen·OpenRouter·NVIDIA·exaone 4개 공급자에서 도구 호출 포함 정상 동작 | 선택자 방식 확정(§3) |
| E2 ✅ V1 `config` hook으로 메모리 내 설정 변경 → xkiro 26개 노출 / `provider.models` hook은 호출되지 않음 | 공급자 모델 갱신은 `config` hook 주입으로 한다(§4.1) |
| E5 ❌ 같은 요청 내 전환 불가 | 기능 제외. 후보 E12(재시도 감지 → abort → continue)를 Phase 4 실험으로 둔다(§6.1) |
| E6 ✅ 하위 에이전트: 자식 `chat.message` 입력 = 부모의 실제 경로, `session.created.parentID`로 식별 | auto 상속 구현 방식 확정(§3.4) |
| E7 ✅ OpenCode 재시도는 같은 모델로 5회, 약 65초 | 장애 판정·가드 설계에 반영(§3.4, §6) |
| E8 ✅ `bun:sqlite` + 다중 프로세스 WAL | 저장소 확정(§8) |
| E9 ✅ 이벤트로 TTFT·TTFA·E2E 계측 가능. 요청 시작은 `chat.headers` 시각 | 관측 방식 확정(§3.5, §5.3) |
| E4 ✅ auth.json의 OpenRouter 키로 Benchmarks 200. **OR이 재배포하는 AA 데이터에 coding_index 151/175, agentic_index 107/175가 있다** | C·A의 주 출처를 OR로 변경(§2.3, §5.1) |
| 사용자 정보: exaone `k-exaone_v2.5`는 2026-11-09 출시 | 벤치마크가 없는 신규 모델 → 신뢰도 보정 + 자체 평가 우선 대상(§5.2, §12) |

### v1.2 변경 (2026-11-10 사용자 결정 반영)

| 결정 | 반영 |
|---|---|
| 1. 가상 모델 방식은 좋으나 **opencode 무료 모델은 OpenCode에서만 호출 가능**하다. 프록시를 거치면 호출되지 않는다 | §3 전면 개정. v1.1의 "라우터가 하위 경로를 직접 호출"하는 방식을 버리고 **선택자(Selector) 방식**을 채택한다. `oamp/auto`는 선택 표식일 뿐이며, OAMP는 `chat.message` hook에서 이번 턴의 모델을 실제 경로로 바꿔 넣는다. 그러면 **모든 모델 호출을 OpenCode가 직접** 수행한다. OAMP는 요청을 재전송하지 않는다 |
| 2. exaone 연결 복구 | ✅ 완료(§2.1). 모델 `k-exaone_v2.5`, 도구 호출 확인, **초당 1회 한도**를 §6·§7에 반영 |
| 3. xkiro 무료 선언 | `freeDeclared` 채택. 추가로 xkiro `/v1/models`가 `access_tier`·`pricing`을 제공하므로 API로 무료 여부를 검증한다(§7) |
| 4. 벤치마크 키 | OpenRouter Benchmarks는 기존 OpenRouter 연결을 재사용한다. AA 무료 키는 **사용자가 발급해 파일로 배치**해야 한다(§10, 계정 생성은 대행하지 않음) |
| 5. 가용성 배수 `H` | 채택(§5.5) |
| 6. OAMP가 모델 갱신 기능을 대체하므로 xkiro 동기화 cron 제거 | ✅ cron 제거 완료(02:5x UTC). 공급자 `/v1/models` 기반 모델 갱신을 OAMP Discovery가 맡는다(§4.1) |
| 7. exaone은 전면 무료 모델로 공개됨 | `freeDeclared`에 `exaone/*` 추가(§7, §10) |

---

## 0. v1.0 대비 핵심 변경 요약

| # | v1.0 | v1.1 | 근거 |
|---|---|---|---|
| 1 | `ctx.model.list`, `ctx.session.switchModel`, `ctx.session.hook("http.request"/"retry")` 사용 | 설치된 패키지에는 해당 API가 없다. **실제 V2 API(`catalog`, `aisdk`, `agent`, `integration`) + V1 Hooks** 기준으로 다시 설계한다. 문서 API는 `host/` 어댑터 뒤로 격리한다 | §2.2 |
| 2 | 기본 모델이나 세션 모델을 자동으로 교체한다 | 💡 **선택 표식 모델 `oamp/auto` 등**: 사용자가 이 모델을 고를 때만 OAMP가 턴마다 실제 모델을 정한다. 호출은 OpenCode가 직접 한다. 다른 모델을 고르면 OAMP는 개입하지 않는다 | §3 |
| 3 | 요청 실패 시 즉시 다른 모델로 전환할 수 있는지 미정 | 💡 기본은 **다음 턴부터 전환**한다. 같은 요청 안의 전환은 OpenCode가 만든 모델 인스턴스끼리, 같은 헤더 계열 안에서, 첫 콘텐츠 전 실패에 한해서만 선택 기능으로 둔다(Phase 4, E5 결과로 결정) | §6 |
| 4 | Coding/Agentic 점수의 주 출처를 AA 지수로 둠 | AA 무료 API는 `coding_index`·`agentic_index`가 **항상 null**이다. C/A는 OpenRouter 자체 평가, 전문 스냅샷, OAMP 자체 평가, 실사용 결과로 구성한다 | §2.3, §5 |
| 5 | `allowUnknownPrice=false`면 비용 정보 없는 모델 제외 | 이 규칙이면 xkiro·exaone이 **전부 제외**된다. 가격 상태 4단계와 사용자 선언(`freeDeclared`)을 도입한다 | §7 |
| 6 | 실측 데이터 0에서 시작 | `opencode.db`의 과거 assistant 메시지 2,443건으로 지연·오류 **사전값(prior)을 부트스트랩**한다 | §2.4 |
| 7 | Health는 필터로만 사용 | 💡 Circuit Breaker 필터에 더해 **가용성 배수 `H`**를 제안한다(FMR 공식 변경이므로 승인 필요) | §5.5 |
| 8 | 명령 등록 위치 미정 | OpenCode Command는 프롬프트 템플릿이다. 결정적 조회는 **`oamp` CLI(SQLite 직접 조회)**, 대화 내 조회는 **플러그인 Tool**로 한다 | §9 |

---

## 1. 목표와 범위 (v1.0 유지, 보완 사항만)

v1.0 §1의 핵심 요구사항 1~9와 초기 범위를 그대로 따른다. 보완 사항은 다음과 같다.

- **수동 선택 우선**은 "선택 표식 모델을 고르지 않으면 OAMP가 개입하지 않는다"는 구조로 보장한다. 사용자 선택을 감지해서 피하는 방식이 아니다.
- **세션 일관성**: 세션마다 경로를 고정(sticky)한다. 사용자 턴 경계나 장애가 있을 때만 다시 평가한다(프롬프트 캐시 보존 목적도 있음).
- **호출 주체**: 모든 모델 호출은 OpenCode가 자기 SDK 인스턴스·헤더·인증으로 수행한다. OAMP는 모델을 고르고 관측만 한다. 따라서 opencode(Zen) 무료 모델도 그대로 쓸 수 있고, 비용 집계도 실제 경로 기준으로 정확하다.

---

## 2. 사전 조사 결과 (2026-11-10)

### 2.1 운영 환경

| 항목 | 결과 |
|---|---|
| OpenCode | ✅ `~/.opencode/bin/opencode` 1.19.5 |
| 플러그인 패키지 | ✅ `~/.config/opencode/node_modules/@opencode-ai/plugin` 1.19.3. npm 1.19.5와 `dist/` 차이 없음 |
| 기존 로컬 플러그인 | ✅ `~/.config/opencode/plugins/orca-opencode-status.js` (V1 함수형 export, 자동 발견) |
| 설정 상태 | ✅ **exaone 복구 완료(02:17 UTC).** 원인은 세 가지였다. ① 키 파일 `exaone-api-key`가 없었다. ② 모델명이 실제 없는 `throw`였다. ③ 빈 `whitelist: []`가 모든 모델을 걸러냈다. 조치: `auth.json`의 exaone 키로 `/v1/models`를 검증한 뒤 키 파일을 0600으로 만들고, `npm: @ai-sdk/openai-compatible`과 모델 `k-exaone_v2.5`(tool_call, reasoning)로 블록을 교체했다. 백업은 `opencode.jsonc.bak-2026-11-10-exaone`. `opencode run --model exaone/k-exaone_v2.5`로 응답을 확인했다 |
| exaone 특성 | ✅ `/v1/models`에 모델 1개. 추론 모델(`reasoning_content`). 도구 호출 정상(`finish_reason: tool_calls`). **초당 1회 한도**(`429 second limit(1)`). 응답 약 1초 |
| xkiro 상태 | ⚠ **OpenCode에서 공급자가 사라져 있다**(`Provider not found: xkiro`). 원인: `whitelist`에는 qwen `:free` 20개가 있는데, 동기화 cron(`tools/sync-xkiro-models.py`, 6시간 주기)이 11-09에 `models`를 cohere·mistral 등 26개로 갈아 끼웠다. 두 목록이 겹치지 않아 모델이 0개가 됐다. **cron은 사용자 지시로 제거했다**(crontab 백업: `/srv/cloud-workspace/memory/crontab-backup-2026-11-10.txt`). 스크립트 파일은 xkiro 어댑터 참고용으로 남겼다. whitelist 처리는 §4.1 방식 결정 후 정리한다 |
| 현재 활성 경로 | ✅ `opencode models`: exaone 1, nvidia 37, opencode 8, openrouter 14, xkiro 0 |
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
- 바이너리 내장 공급자(azure, bedrock, gitlab 등)가 바로 이 `catalog.transform`/`aisdk.language`로 구현되어 있다 ✅ → 내장 확장점이지만 **외부 플러그인에는 열려 있지 않다**(E1).

> ⚠ **E1 결과: 위 V2 API는 OpenCode 내장 플러그인 전용이다. 외부 플러그인은 로드되지 않는다**(1.19.5). OAMP는 아래 V1 Hooks만 사용한다.

**V1 Hooks (`@opencode-ai/plugin` 기본 export)** ✅ 타입 확인, OAMP가 사용하는 API

`event`, `config`, `tool`, `provider.models`, `chat.message`, `chat.params`, `chat.headers`, `tool.execute.before/after`, `experimental.*`. **retry hook과 http hook은 없다.**

**공식 문서(opencode.ai/docs/build/plugins/server)의 API**: `import { Plugin } from "@opencode/plugin"`, `ctx.model.*`, `ctx.session.hook("context"|"model.request"|"prompt"|...)`, 설정 키 `plugins`.
→ 현재 npm 패키지와 바이너리에 해당 import 경로가 없다(`@opencode/plugin` 문자열 0건). **향후 버전 API로 판단**하고 `host/docs-v2.ts` 어댑터 자리만 남긴다. ⚠
- 세션 모델 전환 HTTP API는 ✅ 있다: `POST /api/session/{sessionID}/model` (SDK v2 `switchModel`, "subsequent provider turns"). 보조 기능으로만 쓴다.
- 문서: "진행 중인 요청은 시작 시 설정을 유지한다" → 요청 도중 모델 교체는 공식 경로가 없다. 그래서 v1.2는 턴 단위로 선택한다(§3, §6).

### 2.3 벤치마크 API 실체 (v1.0 §4.1 정정)

| 출처 | 확인 내용 |
|---|---|
| OpenRouter `GET /api/v1/benchmarks` | ✅ Bearer(일반 OR 키), 분당 30회·일 500회. `source=artificial-analysis\|design-arena\|openrouter`, `task_type=coding\|intelligence\|agentic\|search`. AA 항목: `model_permaslug`, `intelligence_index`, `coding_index`, `agentic_index`, `pricing`. OR 자체 평가: `benchmark_type`(`gpqa_diamond`, `tau_bench_verified_airline`, search 계열), `accuracy`, `accuracy_stddev`, `total_tasks`, `last_run_timestamp`. `meta.as_of`, `meta.citation`(재게시 시 필수 표기), `meta.version=v1` |
| AA `GET /api/v2/language/models/free` | ✅ `x-api-key`, 첫 요청부터 24시간 고정 윈도 100회. `X-RateLimit-*`, `Retry-After`. 필드: `slug`, `model_creator`, `evaluations.artificial_analysis_intelligence_index`, `pricing.price_1m_*`, `performance.median_output_tokens_per_second`, `median_time_to_first_token_seconds`, `median_time_to_first_answer_token_seconds`, `median_end_to_end_response_time_seconds`. **`coding_index`·`agentic_index`는 항상 null**(공식 문서 명시). 표시할 때 출처 표기 필수 |
| AA 키 실측(2026-11-10) | ✅ 사용자 키로 1회 호출 200, `X-Aa-Tier: free`, 한도 100/남은 99. 전체 약 800개 모델이 200개씩 4페이지 → **수집 1회 = 4요청**. 1페이지 200개 중 `intelligence_index` 있는 모델은 **39개**, coding/agentic은 0개(문서와 일치). slug에 변형이 들어 있다(`qwen3-5-397b-a17b` vs `…-non-reasoning`) → Identity가 reasoning 변형을 구분해야 한다. exaone은 `k-exaone-2-0-0803`, `exaone-4-5-33b-non-reasoning` 등이 있으나 `k-exaone_v2.5`와 정확히 일치하는 항목은 1페이지에 없다 |
| 공급자별 속도 | 두 API 모두 무료 등급에서는 **모델 단위 중앙값만** 제공한다(AA 공급자별 데이터는 Commercial). → 경로별 속도는 **OAMP 실측만** 쓴다 |
| 모델 ID 매핑 | OR `model_permaslug` ↔ OpenCode `openrouter/<id>`는 직접 대응된다. AA `slug`(예: `glm-5-3`) ↔ 기타 경로는 Identity 매핑이 필요하다(AA Pro에는 `openrouter_api_id`가 있으나 무료 등급에는 없다) |

> **v1.3 정정 (E4 실측)**: OpenRouter Benchmarks의 `source=artificial-analysis` 행은 AA 무료 API와 달리 `coding_index`(151/175)·`agentic_index`(107/175)를 제공한다. 따라서 **C·A의 주 출처는 OR**이고, AA 무료 API는 I(OR에 없을 때)와 속도 사전값을 맡는다. 같은 AA 측정을 두 경로로 받으므로 지표별로 한 출처만 채택한다.
>
> (v1.2 결론, 참고) 무료 출처에서 바로 얻을 수 있는 값은 **I(AA·OR intelligence)**, **A의 일부(OR `tau_bench_verified_airline`)**, **모델 단위 속도 사전값(AA)**이다. **C(코딩)는 무료 API로는 사실상 공백**이다. 전문 스냅샷(SWE-bench Pro, LiveCodeBench 등)은 무료·소형 모델 커버리지가 낮을 것으로 예상하므로(⚠ 수집 시 확인), 자체 평가를 Phase 5에서 **Phase 2로 앞당긴다**.

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
- 메시지에 기록되는 것은 최종 결과뿐이다. OpenCode 내부 재시도로 흡수된 429는 빠져 있다 → 재시도 횟수는 이벤트 관측(§3.5)으로 따로 센다.

---

## 3. 💡 핵심 설계: 선택 표식 모델 + 선택자(Selector)

### 3.1 왜 v1.1 방식을 버렸나

v1.1은 `aisdk.language` hook으로 `oamp/auto` 자리에 라우터 LanguageModel을 넣었다. 그 라우터가 하위 경로의 SDK 클라이언트를 **직접 만들어** 호출하는 구조였다. 이 구조는 opencode(Zen) 무료 모델에서 실패한다. 근거는 다음과 같다.

- ✅ OpenCode는 요청 헤더를 `model.providerID.startsWith("opencode")`로 나눈다(바이너리 확인).
  - opencode 계열이면 `x-opencode-project`, `x-opencode-session`, `x-opencode-request`(사용자 메시지 ID), `x-opencode-client`, `User-Agent: opencode/<버전>`을 붙인다.
  - 그 외 공급자에는 `x-session-affinity`, `X-Session-Id`, `User-Agent`만 붙인다.
- ✅ opencode 공급자는 키가 없으면 `apiKey: "public"`으로 무료 모델만 연다.
- 따라서 `oamp` 공급자 요청을 플러그인이 Zen으로 다시 보내면 OpenCode 고유 헤더와 인증 맥락이 빠진다. 사용자 지적대로 이는 프록시 호출이 되어 거부된다. 헤더를 흉내 내는 방식은 OpenCode 내부 구현에 기대는 우회이므로 채택하지 않는다.

### 3.2 개념

| 선택 표식 모델 | 풀 | 가중치 프로필 |
|---|---|---|
| `oamp/auto` | 기본 | FMR 기본(C55/A30/I15, P70/L30, ×H) |
| `oamp/coding` | 코딩 | C 비중 상향(향후) |
| `oamp/agentic` | 에이전트 | A 비중 상향(향후) |
| `oamp/fast` | 빠른 응답 | L 비중 상향(향후) |

- `oamp/*`는 **선택 표식**이다. 실제로 호출되는 모델이 아니다.
- 사용자가 `oamp/*`를 고르면(TUI `/models`, `opencode run --model oamp/auto`, agent의 `model` 설정) OAMP가 **턴마다 실제 경로를 골라 그 턴의 모델로 기록**한다. 그 뒤 호출, 재시도, 도구 실행, 비용 집계는 모두 OpenCode가 평소대로 처리한다.
- 다른 모델을 고르면 OAMP는 관측만 한다.

### 3.3 동작 흐름

```text
사용자 프롬프트 (model = oamp/auto)
  └─ OpenCode: 사용자 메시지 생성
       └─ [V1 chat.message hook]  input.model == oamp/*  ?
            ├─ 예 → Selector.pick(pool, session, 요청 특성)
            │        output.message.model = {providerID, modelID(, variant)} ← 실제 경로로 교체
            │        세션 상태 기록(auto=true, pool, 선택 경로, 사유)
            └─ 아니오 → 개입 없음
       └─ OpenCode: 메시지 저장 → agent loop가 사용자 메시지의 model로 호출
            (Zen이면 Zen 헤더·인증으로, 각 공급자 고유 경로로 직접 호출)
       └─ [관측] 스트림 계측(§3.5) → telemetry
```

- ✅ 바이너리 확인: `chat.message`는 `{message, parts}` 출력 객체를 넘긴 **뒤에** 메시지를 검증·저장한다. 따라서 hook에서 `output.message.model`을 바꾸면 저장되는 모델이 바뀐다. agent loop는 마지막 사용자 메시지의 모델을 쓴다. ⚠ 실제 반영 여부와 TUI 표시는 E3에서 확인한다.
- 한 턴(사용자 메시지 1건) 안의 모든 단계(도구 호출 반복 포함)는 같은 경로를 쓴다. 턴 안에서 모델이 바뀌지 않으므로 세션 일관성과 도구 중복 방지가 구조적으로 보장된다.
- 다음 턴에도 TUI가 `oamp/auto`를 보낸다. OAMP는 sticky 규칙(§3.6)에 따라 같은 경로를 유지하거나 바꾼다.

### 3.4 보조 경로

| 상황 | 처리 |
|---|---|
| 하위 에이전트(task 도구) 세션 | ✅ E6: 자식 세션의 `chat.message` 입력 모델은 부모 턴의 실제 경로다. `session.created` 이벤트의 `parentID`로 부모를 찾는다. 부모가 auto면 자식도 auto로 보고 같은 풀에서 고른다. agent에 모델이 명시돼 있으면 따른다 |
| title·compaction 등 small model 요청 | OpenCode가 실제 경로 공급자의 small model을 쓴다. OAMP는 개입하지 않는다 |
| hook 실패·OAMP 비활성 상태에서 `oamp/auto` 요청이 그대로 나간 경우 | `oamp` baseURL `127.0.0.1:9` 연결 거부로 끝난다. 외부 전송은 없다. 단 OpenCode 재시도 때문에 **약 65초 뒤에** 오류가 난다(E7). V1에는 즉시 실패시킬 수단이 없으므로, 선택자는 후보가 비어도 반드시 하나를 고른다(최후 수단 = Health를 무시한 최고 점수 경로) |
| 세션 중간에 사용자가 실제 모델을 직접 고름 | 그 턴부터 수동 선택이다. auto 상태를 해제한다 |
| `switchModel` HTTP API(`POST /api/session/{id}/model`) | 기본 경로가 아니다. chat.message 교체가 E3에서 실패할 때만 대안으로 쓴다(다음 턴부터 적용) |

### 3.5 관측(텔레메트리) 방법

OAMP는 요청을 재전송하지 않으므로, 계측은 OpenCode의 실제 호출을 **관측만** 한다.

| 방법 | 내용 | 우선순위 |
|---|---|---|
| A. 이벤트 관측 | ✅ E9. 요청 시작 = V1 `chat.headers` 호출 시각(단계마다 1회). 첫 파트 = `message.part.updated`(reasoning/text/tool). 완료·토큰·오류 = `message.updated`. 재시도 = `session.status{type:"retry"}` | **기본** |
| ~~B. 스트림 관측 래퍼~~ | `aisdk.language`가 외부 플러그인에 없어 불가(E1) | 제외 |
| C. opencode.db 대조 | 주기적으로 읽기 전용 조회해 A의 누락을 보정하고 부트스트랩한다 | 보조 |

- 관측 대상은 auto 세션만이 아니라 **모든 세션**이다. 사용자가 직접 고른 모델의 실측도 점수에 반영해 표본을 늘린다.
- OpenCode 내부 재시도는 `session.status{type:"retry", attempt, message, next}` 이벤트로 횟수와 원인을 센다 ✅(E7).

### 3.6 세션 고정(sticky)과 재선택

같은 세션은 직전 성공 경로를 유지한다. 다음 경우에만 새 턴에서 다시 고른다.

1. 직전 턴이 오류로 끝났거나 현재 경로가 `cooldown`·`open`·`disabled` 상태인 경우 → **장애 전환**(§6)
2. 최상위 후보와의 점수 차가 `switchMargin`(기본 5점) 이상이고 그 상태가 `switchHoldMinutes`(기본 30분) 이상 지속된 경우
3. 추정 입력 토큰이 현재 경로 컨텍스트 한도의 80%를 넘는 경우
4. 동시 실행 한도(§7.3)가 걸린 경로에 다른 세션이 이미 몰려 있는 경우(새 세션에만 적용)

### 3.7 선택 표식 모델 등록

- `opencode.jsonc`의 `provider.oamp`에 `auto`, `fast` 등을 정의한다. `catalog.transform`으로 생성할 수 있으면(E2) 설정 대신 그 방식을 쓴다.
- `capabilities.tools = true`, `limit.context`는 풀 후보의 하한값(TUI 표시용). `cost = 0`.
- 실제 호출이 일어나지 않으므로 baseURL은 쓰이지 않는다. 그래도 오설정 시 외부 전송을 막기 위해 `http://127.0.0.1:9/`(discard)로 둔다.

---

## 4. 모듈 구성과 저장소 구조

```text
opencode-adaptive-model-pool/
  package.json            # bun + TypeScript, @opencode-ai/plugin 버전 고정
  src/
    index.ts              # 플러그인 진입점 (V2 define + V1 hooks shim)
    host/                 # OpenCode 연동 경계 (버전 의존 코드는 여기에만)
      v1-hooks.ts         #   chat.message(선택자), event(관측), chat.headers(요청 시작 시각), config(모델 주입), tool(oamp_status 등)
      docs-v2.ts          #   (향후) ctx.model/ctx.session API
    selector/             # 턴 단위 경로 선택, sticky, 세션 상태(auto/pool/부모 상속), 장애 전환
    discovery/            # 카탈로그 동기화, 신규/stale/폐지 상태 전이
    identity/             # canonical / variant / route ID, 매핑 신뢰도
    benchmarks/           # openrouter.ts, artificial-analysis.ts, snapshots/, selfeval/
    telemetry/            # 이벤트 관측 → 요청 계측, 버킷 집계, EWMA, p50/p95, opencode.db 부트스트랩
    scoring/              # P, L, c, H, R 계산 (순수 함수)
    health/               # 오류 분류, Cooldown, Circuit Breaker, 복구 Probe
    policy/               # 가격 상태, 허용/차단, 풀 정의
    storage/              # bun:sqlite, schema.sql, migrations/, lease
    cli/                  # oamp status/rank/model/refresh/probe/history/stats
  test/
    fakes/event-stream.ts          # message.updated/part.updated 이벤트 재생(지연·오류·중단 시나리오)
    fakes/fake-language-model.ts   # (선택 기능) 관측 래퍼·같은 요청 전환 시험용
  docs/
```

### 4.1 공급자 모델 갱신 (xkiro 동기화 cron 대체)

OAMP Discovery가 공급자 `/v1/models`를 6시간마다 조회해 OpenCode 노출 모델을 갱신한다. 대상은 xkiro와 exaone이다. 기존 `sync-xkiro-models.py`의 안전장치를 그대로 옮긴다. 수집 대상 URL은 고정하고 리디렉션은 거부한다. 빈 목록이나 형식 오류가 오면 기존 상태를 유지한다. 자격증명은 마스킹한다.

| 방식 | 내용 | 우선순위 |
|---|---|---|
| A. `config` hook 주입 | ✅ E2. OpenCode 시작 시 V1 `config` hook이 메모리 내 설정을 받는다. OAMP가 SQLite에 캐시한 공급자 모델 목록으로 `provider.<id>.models`를 채우고, 충돌하는 `whitelist`를 메모리에서 정리한다. 설정 파일은 건드리지 않는다. 목록 수집은 백그라운드에서 하고 다음 OpenCode 프로세스부터 반영된다 | 기본 |
| B. 설정 파일 갱신 | `provider.<id>.models` 키만 갱신한다(기존 스크립트와 같은 방식). 잠금, 원자적 쓰기, 백업, 동시 변경 감지, `whitelist` 동기화를 적용한다 | A가 불가할 때 |

- xkiro 필터: `access_tier == 'free'`이고 `pricing.input/output == 0`인 chat 모델만 넣는다(기존 스크립트 규칙 승계).
- 목록에서 빠진 모델은 바로 지우지 않는다. 먼저 `stale`로 바꾸고, 2회 연속 빠지면 `retired`로 처리한다(v1.0 §10).
- 갱신 결과는 `oamp status`와 상태 파일(`~/.local/share/oamp/provider-sync.json`)에 기록한다.

- `scoring/`, `health/`, `policy/`, `identity/`는 **순수 함수 모듈**로 만들고 OpenCode 의존성을 두지 않는다 → 단위 테스트 대상.
- 버전 의존 코드는 `host/`에만 둔다. OpenCode가 문서상 API(`ctx.model`, `ctx.session.hook`)로 바뀌면 어댑터만 교체한다.

---

## 5. 점수 모델 (v1.0 §6~8 구체화)

### 5.1 지표 → 상위 점수 매핑 (데이터 가용성 반영)

| 상위 | 지표(분류 내부 가중치 초안) | 출처 | 비고 |
|---|---|---|---|
| **C** Coding | **OR(AA) `coding_index` 40** / OAMP 자체 코딩 평가 25 / SWE-bench Pro 15 / OpenCode 실사용 작업 성공률 20 | OR, selfeval, 스냅샷, telemetry | v1.3: OR 실측 반영. 실사용 성공률은 표본 30건 이상일 때만 반영 |
| **A** Agentic | **OR(AA) `agentic_index` 35** / OR `tau_bench_verified_airline` 25 / OAMP 자체 tool-call 평가 25 / Terminal-Bench·MCP Atlas·BFCL 15 | OR, selfeval, 스냅샷 | |
| **I** Reasoning | AA `intelligence_index` 60(OR 경유 또는 AA 직접 중 하나) / OR `gpqa_diamond` 25 / LiveBench 15 | OR, AA, 스냅샷 | 같은 AA 측정은 **한 출처만** 채택(OR 우선, 없으면 AA 직접) |

- 결측 지표는 v1.0 원칙대로 제외하고 남은 가중치를 재정규화한다.
- 신규 모델(예: exaone `k-exaone_v2.5`, 2026-11-09 출시)은 외부 지표가 없으므로 `c`가 낮다(P_eff ≈ 50). 자체 평가와 실사용 측정이 쌓이면서 점수가 움직인다.
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

- 지표 정의는 v1.0 §7.1을 따르고 OpenCode 이벤트 관측(§3.5 A)으로 측정한다. 기준 시각은 assistant 메시지 `time.created`다.
  - **TTFT**: 첫 `text`·`reasoning`·`tool` 파트 생성 시각까지
  - **TTFA**: 첫 `text` 또는 `tool` 파트까지(reasoning 제외)
  - **E2E**: `time.completed`까지(한 모델 요청 단위 = assistant 메시지 1건)
  - **TPS**: (output + reasoning 토큰) / (E2E − TTFT)
  - 이벤트 시각 정밀도가 부족하면(E9) 관측 래퍼(§3.5 B)로 바꾼다.
- 환산: `S = 100 × clamp((ln ref_max − ln x) / (ln ref_max − ln ref_min), 0, 1)`(TPS는 방향 반대). 버킷은 입력 토큰 구간 `0–2k / 2–16k / 16–64k / 64k+` × 요청 종류(primary/보조)로 나눈다.
- 초기 `ref_min/ref_max`는 §2.4 부트스트랩 분포의 p10/p90으로 정해 저장하고 고정한다.
- 표본 축소(shrinkage): `L_route = (n·L_obs + n0·L_prior) / (n + n0)`, `n0 = 10`. `L_prior` 우선순위: 같은 경로 과거 데이터(opencode.db) → AA 모델 중앙값 → 중립 50.
- EWMA `α = 0.25`를 쓰고 p50/p95는 최근 200건 링버퍼로 계산한다.

### 5.4 최종 점수

```text
R = 0.70·P_eff + 0.30·L          (v1.0 유지)
```

### 5.5 가용성 배수 `H` (2026-11-10 채택)

무료 경로의 실제 장애는 429·403·404가 대부분이다(§2.4). 필터만 쓰면 Cooldown이 풀린 직후 같은 경로가 다시 최상위로 올라와 실패를 반복한다. 그래서 다음을 적용한다.

```text
H = clamp(success_ewma, 0.5, 1.0) ^ 2      (사용자 중단은 제외, 최근 50건 기준)
R_final = R × H
```

- 기본값 `weights.availabilityPenalty: true`. `false`로 두면 `H = 1`(v1.0 공식)이다.
- 표본이 5건 미만이면 `success_ewma`의 사전값으로 §2.4 부트스트랩 성공률을 쓴다(없으면 0.9).

### 5.6 선택 절차 (v1.0 §8 구체화)

1. 풀 후보 = 활성 카탈로그 ∩ 정책 허용 ∩ `capabilities.tools` ∩ 컨텍스트 한도 ≥ 추정 입력 토큰 × 1.2
2. Health 상태가 `cooldown`·`open`·`disabled`인 경로 제외
3. `R_final` 계산 → 내림차순
4. 동점(±1점): 최근 p95 E2E가 낮은 쪽 → 실패율이 낮은 쪽 → 직전 선택과 다른 공급자
5. 탐색: 확률 `explorationBudget`(5%)로 `probation` 상태 경로 하나를 1순위에 둔다. 단 **새 세션의 첫 턴에만** 적용한다. 실패하면 다음 턴에 정상 후보로 돌아간다
6. 선택 결과, 후보 상위 4개 점수, 사유 코드를 `rank_history`에 기록한다

---

## 6. 장애 대응과 Failover (v1.2: 턴 단위 전환 기본)

### 6.1 전환 단계

OAMP는 요청을 재전송하지 않는다. 따라서 장애 대응은 아래 3단계다.

| 단계 | 주체 | 내용 | 시점 |
|---|---|---|---|
| ① 같은 경로 재시도 | OpenCode | 429·5xx 등에서 OpenCode 자체 재시도·백오프(⚠ 횟수·지연은 E7에서 관측) | 같은 요청 |
| ② 다음 턴 전환 | OAMP Selector | 직전 턴 오류·Health 상태를 보고 다음 `chat.message`에서 다른 경로를 고른다 | 다음 사용자 턴 |
| ~~③ 같은 요청 내 전환~~ | — | **E5 불가로 제외**(`aisdk.language`가 외부 플러그인에 없음). 아래 조건은 기록으로만 남긴다. 대안 후보 E12: `session.status retry` 감지 → `session.abort` → 다음 경로로 "continue" 프롬프트(Phase 4 실험) | — |

**(참고, 비활성) ③의 조건**

1. 전환 대상 모델 인스턴스가 **OpenCode가 직접 만든 것**이다. `aisdk.language` hook에서 받은 `e.language`를 캐시해 쓴다. 플러그인은 SDK 클라이언트를 새로 만들지 않는다.
2. 원 요청과 대상이 **같은 헤더 계열**이다. opencode 계열끼리 또는 비-opencode 계열끼리만 허용한다. OpenCode가 원 요청에 붙인 헤더를 그대로 쓰므로 Zen 맥락이 유지되고, Zen 헤더가 타 공급자로 새지 않는다.
3. 첫 콘텐츠 파트(`text-delta`, `reasoning-delta`, `tool-input-start`, `tool-call`)가 OpenCode에 전달되기 **전**의 실패다. 이 시점에는 출력도 도구 실행도 없으므로 중복 부작용이 없다.
4. 요청당 최대 4경로, 누적 30초(v1.0 유지). 시도한 경로 집합으로 순환을 막는다.

- 첫 콘텐츠 전달 뒤 실패는 어느 단계에서도 **재실행하지 않는다**. AI SDK는 `tool-call` 파트를 받는 즉시 도구를 실행할 수 있다.
- 사용자 중단(`abortSignal`, `MessageAbortedError`)은 장애가 아니며 전환하지 않는다.
- **턴 실패 안내**: 턴이 오류로 끝나면 OAMP가 TUI 토스트·로그로 "다음 턴부터 `<경로>`로 전환"을 알린다(⚠ V1에서 토스트를 띄우는 수단은 E11에서 확인). 자동 재프롬프트는 하지 않는다. 사용자 의도 없이 작업을 다시 실행하지 않는다는 v1.0 §9.2 원칙에 따른 것이다.

### 6.2 오류 분류 (실데이터 반영)

| 분류 | 판정 | 처리 |
|---|---|---|
| `rate_limit` | 429 | `Retry-After` 우선, 없으면 60s→120s→300s 지수 Cooldown. 다음 턴 전환(③ 활성 시 같은 요청 전환) |
| `server` | 5xx, 연결 오류 | 경로 연속 3회 실패 시 Circuit Open(120s). 다음 턴 전환 |
| `timeout` | 첫 콘텐츠 지연이 경로 p95 × 3 또는 120초 초과 | 관측만 하고 `slow`로 표시한다(L 점수 반영). 요청 중단은 OpenCode에 맡긴다 |
| `auth` | 401 | 공급자 단위 `disabled`, 자동 복구 Probe 중단, 사용자 알림 |
| `forbidden` | 403 | 경로 `disabled`(유료·권한 문제 가능). 일 1회 Probe만 수행 |
| `not_found` | 404, "model not found" | 경로 `stale` → 카탈로그 재확인 후 폐지 처리 |
| `bad_request` | 400(컨텍스트 초과 제외) | 해당 경로 × 기능 조합(예: 이미지 입력)을 제외한다 |
| `context_overflow` | 400 + context 관련 메시지 | 다음 턴에 더 큰 컨텍스트 후보로 전환. 현재 턴은 OpenCode compaction에 맡김 |
| `aborted` | abortSignal, `MessageAbortedError` | 장애로 집계하지 않음 |
| `post_commit` | 첫 콘텐츠 이후 오류 | 기록만 함. 재실행 안 함 |

### 6.3 복구

- Cooldown이 끝나면 경로를 `probation`으로 둔다. 다음 중 하나로 1회 검증한다: 새 세션 첫 턴의 탐색 슬롯, 또는 일 상한 안의 최소 Probe. 성공하면 `healthy`로 되돌린다.
- **Probe도 OpenCode를 통해 실행한다**: `opencode run --model <경로> --format json`(또는 SDK `session.prompt`)으로 별도 Probe 세션에서 고정 프롬프트를 보낸다. Zen 무료 모델도 이 방식이면 OpenCode 고유 경로로 호출된다. 플러그인이 공급자 API를 직접 호출하는 것은 카탈로그 조회(`/v1/models`)와 벤치마크 수집에만 허용한다.
- Probe 결과는 `request_metrics.kind = 'probe'`로 분리 저장하고, Probe 세션은 끝나면 정리한다(v1.0 §7.3).

---

## 7. 가격·사용 정책 (v1.0 §11 정정)

### 7.1 가격 상태

| 가격 상태 | 판정 규칙 | `allowPaid=false`에서 |
|---|---|---|
| `free_verified` | (카탈로그 cost input=output=0 **이고** ID에 `:free`/`-free`가 있거나 무료 공급자로 등록됨) **또는** 공급자 `/v1/models`가 무료로 표시함(xkiro `access_tier=free` & `pricing.input/output=0`) | 허용 |
| `free_quota` | cost 0이지만 크레딧·쿼터 기반 공급자(nvidia) | 허용, 쿼터 소진 오류(429/403)를 `rate_limit`으로 처리 |
| `free_declared` | 비용 정보가 없고 설정 `freeDeclared` 패턴에 해당 | 허용 |
| `paid` | cost > 0, 또는 ID에 무료 표식이 없는 OR 모델 | 차단 |
| `unknown` | 그 외 | `allowUnknownPrice=true`일 때만 허용 |

### 7.2 현재 설정 적용 결과

- **xkiro**: 사용자 결정에 따라 `freeDeclared: ["xkiro/*"]`를 둔다. 동기화 스크립트가 `access_tier == 'free'`만 등록하므로 OAMP는 xkiro `/v1/models`의 `pricing`으로 `free_verified`까지 확인한다. 둘이 어긋나면 `paid`를 우선해 차단한다. 단, 현재 xkiro는 whitelist 불일치로 OpenCode에 0개만 노출되므로(§2.1) 먼저 고쳐야 한다.
- **exaone**: 사용자 확인(2026-11-10): 전면 무료 공개 모델이다 → `freeDeclared: ["exaone/*"]`, 가격 상태 `free_declared`. 초당 1회 한도는 §7.3으로 관리한다.
- **openrouter**: whitelist의 `z-ai/glm-5.3-flash`, `google/lyria-*`(무료 표식 없음)는 `paid`로 차단한다. 과거 403이 실제로 발생했다.
- **opencode(Zen)**: `-free` 접미사 + cost 0인 모델만 `free_verified`.
- **모달리티 필터**: 이미지·음성·임베딩·안전성 분류 모델(flux, whisper, rerank, content-safety 등)은 `capabilities.output`에 text가 없거나 tools=false이므로 자동 제외한다.

### 7.3 경로별 동시 실행·속도 한도

- exaone: 초당 1회(✅ 실측 429 메시지). OpenCode의 agent loop는 도구 실행 뒤 연속 요청을 보내고, 하위 에이전트를 여러 개 띄우면 동시 요청이 생긴다. 그래서 `routeLimits`에 `{"exaone/*": {"rps": 1, "maxSessions": 1}}`을 두고, 이미 다른 auto 세션이 쓰고 있는 경로는 새 세션에 배정하지 않는다(§3.6-4).
- 다른 공급자는 429 발생 이력으로 자동 학습한다(경로별 최근 10분 429 비율이 20%를 넘으면 `maxSessions`를 임시로 1로 낮춤).

---

## 8. 저장소 (v1.0 §5.2, §10 구체화)

- 엔진: `bun:sqlite` ✅(E8: 플러그인 안에서 동작, 프로세스 2개 동시 기록 정상)
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

- `pin`은 `oamp/*`를 쓰는 세션 안에서 경로를 고정한다. 모델 자체를 고정하려면 OpenCode에서 실제 모델을 직접 고르면 된다(§3.2).
- 화면에 표시할 때 AA·OR `meta.citation` 출처 표기를 붙인다.

---

## 10. 설정 스키마 v1.2

```jsonc
{
  "plugin": [   // ✅ 1.19.5: V1 키 "plugin", 모듈은 V1 함수 export(E1)
    ["file:///home/ubuntu/orca/projects/opencode-adaptive-model-pool/src/index.ts", {
      "enabled": true,
      "pools": {
        "auto": { "providers": ["opencode", "openrouter", "nvidia", "xkiro", "exaone"] },
        "fast": { "inherit": "auto", "weights": { "performance": 0.4, "latency": 0.6 } }
      },
      "policy": {
        "allowPaid": false,
        "allowUnknownPrice": false,
        "freeDeclared": ["xkiro/*", "exaone/*"],   // 2026-11-10 사용자 결정
        "deny": [],                         // route glob
        "requireToolCalling": true,
        "explorationBudget": 0.05,
        "switchMargin": 5,
        "switchHoldMinutes": 30,
        "inheritAutoToSubagents": true,
        "turnFailover": true                // 다음 턴 전환(§6.1 ②)
      },
      "routeLimits": {
        "exaone/*": { "rps": 1, "maxSessions": 1 }
      },
      "weights": {
        "performance": 0.70, "latency": 0.30,
        "coding": 0.55, "agentic": 0.30, "reasoning": 0.15,
        "availabilityPenalty": true         // §5.5, 2026-11-10 채택
      },
      "latency": { "ttfa": 0.35, "e2e": 0.45, "tps": 0.20, "ewmaAlpha": 0.25, "priorWeight": 10 },
      "benchmarks": {
        "openrouter": { "enabled": true, "credential": "opencode-auth:openrouter" },   // auth.json 읽기 전용(E4)
        "artificialAnalysis": { "enabled": true, "keyFile": "~/.config/oamp/aa-api-key" } // 파일이 없으면 자동 비활성
      },
      "probe": { "maxPerDay": 20, "via": "opencode-run" },
      "refresh": { "catalogHours": 6, "providerModelsHours": 6, "benchmarkHours": 24, "snapshotDays": 7 },
      "providerSync": { "xkiro": { "filter": "free-chat" }, "exaone": {} },   // §4.1
      "storage": { "path": "~/.local/share/oamp/oamp.db" }
    }]
  ],
  "provider": {
    "oamp": {                               // 선택 표식 모델. 실제 호출되지 않음(§3.7)
      "npm": "@ai-sdk/openai-compatible",
      "name": "OAMP (auto)",
      "options": { "baseURL": "http://127.0.0.1:9/v1" },
      "models": {
        "auto": { "name": "OAMP auto", "tool_call": true },
        "fast": { "name": "OAMP fast", "tool_call": true }
      }
    }
  }
}
```

- **OpenRouter 키 재사용**: `credential: "opencode-auth:openrouter"` = `~/.local/share/opencode/auth.json`의 `openrouter.key` 읽기 전용(E4. V2 `integration`은 E1로 불가). 키는 메모리에만 두고, 요청 대상은 `https://openrouter.ai/api/v1/benchmarks`로 고정한다(리디렉션 불허).
- **AA 키**: AA 계정과 키 발급은 사용자가 직접 한다. 발급한 키를 `~/.config/oamp/aa-api-key`(0600)에 두면 다음 수집 주기부터 쓴다. 파일이 없으면 AA 수집만 건너뛴다.
- 자격증명 값은 설정에 넣지 않는다.
- 사용자의 기존 `provider`, `whitelist`, 인증 설정은 OAMP가 **변경하지 않는다**. 설치와 제거는 `plugin` 항목과 `provider.oamp` 블록만 추가·삭제하면 된다.

---

## 11. Phase 0 — 실현성 실험 (✅ 2026-11-10 수행, 결과는 `docs/compatibility.md`)

각 실험은 격리 설정(`OPENCODE_CONFIG`로 별도 jsonc 지정, 기존 설정 무변경)에서 수행하고 결과를 `docs/compatibility.md`에 기록한다.

| ID | 실험 | 통과 기준 | 실패 시 |
|---|---|---|---|
| E0 | 설정 정상화 | ✅ exaone 완료(`opencode run` 응답 확인). xkiro whitelist 정리 후 `opencode models xkiro` > 0 | xkiro 제외하고 진행 |
| E1 | 외부 플러그인에서 V2 `define({id,setup})` 로드 여부, 설정 키(`plugin`/`plugins`), V1 함수형과 공존 | `setup` 호출, `ctx.catalog` 접근 가능 | V1 전용으로 진행(카탈로그는 SDK `provider.list`·`models.json`으로 대체) |
| E2 | 활성 카탈로그 읽기(cost·tools·limit·status) + `oamp/*` 표식 모델 노출 + **`catalog.transform`으로 xkiro 모델 런타임 추가(whitelist 상호작용 포함)** | `/models`에 `oamp/auto`와 xkiro 모델 표시 | `provider.oamp` config 정의 / 모델 갱신은 §4.1 방식 B |
| **E3** | **`chat.message`에서 `output.message.model`을 실제 경로로 교체** → 그 턴 호출이 교체된 모델로 나가는지. opencode Zen 무료 모델, openrouter, nvidia, exaone 각 1회 | 4개 공급자 모두 응답, assistant 메시지 `providerID/modelID`가 교체 경로, 도구 호출 턴 정상, TUI 표시 확인 | E10 `switchModel`(다음 턴 적용)로 대체. 둘 다 실패하면 **No-go → 재설계 보고** |
| E4 | V2 `integration.connection`으로 OpenRouter 키 획득 | 벤치마크 API 200, 키 로그 미노출 | `auth.json` 읽기 전용 경로 |
| E5 | (선택) 관측 래퍼에서 같은 헤더 계열·OpenCode 생성 인스턴스로 첫 콘텐츠 전 전환 | 가짜 429 → 2순위 응답, 메시지 1건, Zen→Zen 성공 | `inRequestFailover` 기능 제외 |
| E6 | 하위 에이전트(task) 세션의 `chat.message` 입력 모델·부모 세션 식별 | 자식 세션도 auto 상속 가능 | 자식 세션은 부모의 실제 경로 유지 |
| E7 | OpenCode 자체 재시도 정책 관찰(429·5xx) | 재시도 횟수·지연과 관련 이벤트 파악 | — (관측 기록만) |
| E8 | `bun:sqlite` 사용, 2개 프로세스 동시 기록(WAL) | 손상·락 오류 없음 | `node:sqlite` → JSON |
| E9 | V1 `event`의 `message.updated`·`message.part.updated` 시각 정밀도 | 파트 생성 시각으로 TTFT/TTFA 산출 가능(오차 < 100ms) | 관측 래퍼(§3.5 B) |
| E10 | `POST /api/session/{id}/model` 동작 | 다음 턴 모델 변경 | E3 대체 수단에서 제외 |
| E11 | V1에서 TUI 토스트·알림 수단(SDK `tui.showToast` 등) | 장애 전환 안내 표시 | 로그·`oamp status`로만 안내 |

**산출물**: `docs/compatibility.md`, 최소 PoC(`oamp/auto` → 고정 우선순위 2경로 선택, 다음 턴 전환).
**Go/No-go**: E3(또는 E10 대체)이 통과해야 진행한다.

---

## 12. 단계별 작업 (v1.2)

| Phase | 내용 | 산출물 | 완료 기준 |
|---|---|---|---|
| 0 | §11 실험 | compatibility.md, PoC(`poc/phase0/`) | ✅ 완료(2026-11-10). E3 Go |
| 1 | Discovery(**공급자 모델 갱신 포함, §4.1**)·Identity·Storage·Policy + opencode.db 부트스트랩 | 동적 Registry, `oamp status` | 5개 공급자 경로 등록, xkiro 모델이 OpenCode에 노출, 가격 상태·모달리티 필터 테스트 통과  ✅ 2026-11-10 완료: 경로 86개(eligible 57), xkiro 26개 노출, 이력 2,407건, 테스트 19개 통과, 전역 설치 |
| 2 | Benchmark(OR·AA) + **자체 평가 최소 세트(앞당김)** + Performance Score | 경로별 P, c, 출처 이력 | 모든 활성 경로에 P_eff 산출, 출처 중복 없음 |
| 3 | 이벤트 관측 계측 + Latency Score + Selector(턴 단위 선택, sticky, 부모 상속) | `oamp/auto` 실사용, `oamp rank` | 실측 누적에 따라 순위가 바뀌고, 근소한 변동에는 바뀌지 않음 |
| 4 | Health·다음 턴 전환·Probe(OpenCode 경유)·동시성 한도 + (선택) 같은 요청 전환 | 장애 내성 선택자 | §13 장애 시나리오 테스트 통과 |
| 5 | 전문 스냅샷 어댑터·가중치 상관 분석·패키징 | 배포 패키지, 운영 문서 | 설치·제거 시 기존 설정 무변경 |

자체 평가 최소 세트(Phase 2)는 v1.0 §6.4의 1·3번(오류 수정 + 테스트 통과, 스키마 tool call)으로 시작한다. **실행은 `opencode run --model <경로>`로 OpenCode를 경유**한다. Zen 무료 모델도 평가할 수 있고, 실제 harness와도 같아진다. 경로당 과제 10개를 넘기지 않고 일일 실행 상한을 둔다.

---

## 13. 검증 기준 (v1.0 §13 + 추가)

v1.0 §13의 표를 유지하고 다음을 추가한다. 장애 시나리오는 `test/fakes/event-stream.ts`로 재현 가능해야 한다.

| 테스트 | 통과 조건 |
|---|---|
| Zen 무료 모델 선택 | `oamp/auto`에서 opencode `-free` 경로가 선택되면 OpenCode가 직접 호출하고 정상 응답한다(플러그인의 공급자 직접 호출 0건) |
| 표식 모델 미선택 | 직접 선택한 모델 요청에 선택자가 개입하지 않음(관측만) |
| 다음 턴 전환 | 1순위 경로 429로 턴 실패 → 다음 턴에 다른 경로 선택, 실패 턴은 재실행 안 됨 |
| 턴 내 일관성 | 한 턴의 모든 assistant 메시지가 같은 경로 |
| 사용자 중단 | 전환 없음, 장애 집계 없음 |
| 403/404 처리 | `disabled`/`stale` 전이, 반복 선택 없음 |
| exaone 동시성 | auto 세션 2개 동시 실행 시 exaone 배정은 1개 세션만 |
| 가격 상태 | xkiro는 `freeDeclared` + API pricing으로 허용, 둘이 어긋나면 차단. OR `:free` 없는 모델은 차단 |
| 하위 에이전트 | auto 부모의 자식 세션도 풀에서 선택 |
| 자격증명 비노출 | DB·로그·오류 메시지 전수 검사에서 키 문자열 0건 |
| 다중 프로세스 | 프로세스 2개 동시 실행 시 외부 벤치마크 API 호출이 리스로 1회만 발생 |
| AA 한도 | 24시간 100회 중 실사용 ≤ 5회/일 |

---

## 14. 위험 요소

| 위험 | 영향 | 대응 |
|---|---|---|
| OpenCode 업데이트로 V2 API·hook 동작 변경(문서는 이미 다른 API를 설명함) | 선택자 무력화 | `host/` 격리, 버전 고정, `opencode upgrade` 전 E3 회귀 테스트. 문서상 `ctx.session.hook("prompt")`가 나오면 그쪽으로 이전 |
| `chat.message` 모델 교체가 비공식 동작에 기댐 | 향후 버전에서 무시될 수 있음 | E10 `switchModel`(공식 API)을 대체 경로로 유지 |
| 턴 단위 전환이라 같은 요청 안에서는 복구 안 됨 | 장애 턴 1회는 사용자에게 오류로 보임 | OpenCode 자체 재시도 + Health 선제 회피(H, Cooldown) + 선택 기능 ③ |
| 무료 모델의 벤치마크 커버리지 부족 | 순위가 속도 위주로 쏠림 | 자체 평가 앞당김, 대리값, 신뢰도 보정 |
| 프롬프트 캐시 손실 | 지연 증가 | 세션 sticky, 턴 경계에서만 전환 |
| OAMP 설치 전까지 xkiro 모델 갱신 공백 | cron 제거 후 Phase 1 완료 전까지 xkiro 노출 0개 유지 | Phase 1 우선 구현. 급하면 수동으로 `sync-xkiro-models.py` 1회 실행(whitelist 정리 필요) |

---

## 15. 결정 현황

| # | 항목 | 상태 |
|---|---|---|
| 1 | 선택 표식 모델 방식 | ✅ 채택. Zen 무료 모델 제약에 따라 **선택자 방식**으로 개정(§3) |
| 2 | exaone 연결 | ✅ 복구 완료(§2.1) |
| 3 | xkiro 무료 선언 | ✅ `freeDeclared: ["xkiro/*"]` + API pricing 검증 |
| 4 | 벤치마크 키 | ✅ OR 기존 연결 재사용. ✅ AA 키 배치·검증 완료(`~/.config/oamp/aa-api-key`, 0600) |
| 5 | 가용성 배수 H | ✅ 채택 |
| 6 | xkiro 모델 갱신 | ✅ 동기화 cron 제거, OAMP Discovery가 대체(§4.1). 현재 whitelist 불일치로 xkiro 노출 0개 상태는 Phase 1에서 해소 |
| 7 | exaone 가격 상태 | ✅ 전면 무료 → `freeDeclared: exaone/*` |

---

## 16. 참고 근거

- 로컬: 바이너리의 `chat.message` 트리거·요청 헤더 분기(`providerID.startsWith("opencode")`)·opencode 공급자 `apiKey: "public"` 처리, exaone `/v1/models`·chat 실측(2026-11-10), `~/.config/opencode/node_modules/@opencode-ai/plugin/dist/{index.d.ts, v2/promise/*.d.ts, v2/effect/*.d.ts}`, `@opencode-ai/sdk@1.19.5 dist/v2/gen/{sdk.gen.d.ts,types.gen.d.ts}`, `~/.cache/opencode/models.json`, `~/.local/share/opencode/opencode.db`(읽기 전용), OpenCode 1.19.5 바이너리 문자열 검사
- 웹(2026-11-10 조회): opencode.ai/docs/build/plugins/server, /migrate-v1, /docs/models; openrouter.ai/docs/api/api-reference/benchmarks/get-benchmarks; artificialanalysis.ai/data-api/docs, /reference
- 전문 벤치마크 출처 목록은 v1.0 §15를 따르며, 각 리더보드의 최신 버전명은 Phase 5 수집 시점에 다시 확인한다
