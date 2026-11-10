# OAMP Phase 0 호환성 검증 결과

- 수행: 2026-11-10 02:41–03:00 UTC, GCE, Claude Code(coordinator) 직접 수행
- 대상: OpenCode 1.19.5 (`~/.opencode/bin/opencode`)
- 격리: `OPENCODE_CONFIG=/tmp/oamp-poc/opencode.test.jsonc`(전역 설정에 덧붙는 별도 파일). 전역 `opencode.jsonc`는 변경하지 않았다. 작업 디렉터리는 `/tmp/oamp-poc/work`
- 프로브 코드: `poc/phase0/v1-probe.ts`(V1 hooks), `poc/phase0/v2-probe.ts`(V2 define, 로드 실패 확인용)
- 원시 로그: `/tmp/oamp-poc/*.jsonl`(임시. 프롬프트·응답 본문과 자격증명은 기록하지 않음)

## 요약

| ID | 실험 | 판정 | 근거 |
|---|---|---|---|
| E0 | 설정 정상화 | ✅ exaone 통과 / ⏳ xkiro는 Phase 1 | `opencode run --model exaone/k-exaone_v2.5` 응답. xkiro는 whitelist 불일치로 0개(아래 E2 방식으로 해소 가능 확인) |
| E1 | 외부 V2 플러그인(`export default {id, setup}`) 로드 | ❌ **불가** | 로그: `failed to load plugin ... must default export an object with server()`. 외부 플러그인은 **V1 hooks만** 사용 가능 → `catalog.transform`, `aisdk.*`, `integration.*` 사용 불가 |
| E2 | 표식 모델 노출 / 카탈로그 갱신 | ✅ (V1 방식) | `provider.oamp`(테스트 설정)로 `oamp/auto` 노출. **V1 `config` hook**에서 메모리 내 설정을 변경(xkiro `whitelist` 삭제)하자 `opencode models xkiro` 0 → 26개. 파일은 무변경. V1 `provider.models` hook은 호출되지 않음(❌) |
| **E3** | `chat.message`에서 `output.message.model` 교체 | ✅ **통과(핵심)** | `oamp/auto` → opencode(Zen) `deepseek-v4.1-flash-free`, openrouter `cohere/north-mini-code:free`, nvidia `z-ai/glm-5.3-flash`, exaone `k-exaone_v2.5` 4개 모두 실제 경로로 호출되었다. bash 도구 호출 1회와 최종 응답 `oamp-42`가 정상이었다. 저장된 사용자 메시지 모델, 모든 assistant 메시지, title 요청까지 교체 경로를 썼다. CLI 표시도 `build · deepseek-v4.1-flash-free`. Zen 무료 모델이 OpenCode 자체 경로로 정상 응답했다 |
| E4 | OpenRouter 키 재사용 → Benchmarks API | ✅ (auth.json 경로) | V2 `integration`은 E1로 불가. `~/.local/share/opencode/auth.json`의 openrouter 키를 읽기 전용으로 써서 HTTP 200, 1,710행(design-arena 1234 / openrouter 301 / artificial-analysis 175). 키는 출력·저장하지 않음 |
| E5 | 같은 요청 내 전환(관측 래퍼) | ❌ **불가(N/A)** | `aisdk.language`가 V1에 없음(E1). 기능 제외 |
| E6 | 하위 에이전트 세션 | ✅ | 자식 세션의 `chat.message` 입력 모델은 부모 턴의 **실제 경로**(`opencode/deepseek-v4.1-flash-free`)이고 agent는 `general`이다. `session.created` 이벤트의 `parentID`로 부모를 식별할 수 있다 → auto 상속 구현 가능 |
| E7 | OpenCode 자체 재시도 | ✅ 관측 | 연결 거부 시 같은 모델로 **5회 재시도**. 대기 약 2.5 / 4.3 / 9.7 / 16.5 / 30초, 총 약 65초 뒤 `session.error`(APIError, `isRetryable: true`). 이벤트: `session.status {type:"retry", attempt, message, next}` |
| E8 | `bun:sqlite` + 다중 프로세스 WAL | ✅ | 플러그인 안에서 `import("bun:sqlite")` 동작. OpenCode 프로세스 2개가 동시에 같은 DB에 200행씩 기록, 총 400행, 오류 없음 |
| E9 | 이벤트로 속도 계측 | ✅ | 요청 시작 = `chat.headers` 시각(assistant 메시지 `time.created`는 실제 요청보다 최대 약 2.3초 **앞선다**). TTFT = 첫 reasoning/text/tool 파트 이벤트, TTFA = 첫 text/tool 파트, E2E = `time.completed`. 도구를 쓰는 턴은 단계마다 assistant 메시지가 1건씩 생긴다 |
| E10 | `switchModel` HTTP API | — 불필요 | E3 통과로 대체 수단 불필요. 시험하지 않음 |
| E11 | TUI 알림 수단 | ⚠ 타입만 확인 | V1 SDK `client.tui.showToast` 존재(`sdk.gen.d.ts:364`). 헤드리스 `opencode run`에서는 TUI가 없어 실동작 미확인 |

## E9 측정값 (참고, 각 1회)

| 경로 | 단계 | TTFT | TTFA | E2E | 출력 토큰 |
|---|---|---:|---:|---:|---:|
| exaone/k-exaone_v2.5 | tool-calls / stop | 0.93s / 0.42s | 1.65s / 1.07s | 2.20s / 1.19s | 45 / 23 |
| openrouter/cohere/north-mini-code:free | tool-calls / stop | 1.21s / 0.86s | 1.84s / 1.04s | 2.05s / 1.09s | 133 / 41 |
| opencode/deepseek-v4.1-flash-free | tool-calls / stop | 2.16s / 1.90s | 2.16s / 1.90s | 2.45s / 1.93s | 46 / 6 |
| nvidia/z-ai/glm-5.3-flash | tool-calls / stop | 21.7s / 21.7s | 22.3s / 21.7s | 22.8s / 21.8s | 68 / 6 |

NVIDIA의 약 21초 TTFT는 과거 이력(E2E p50 25.7초)과 일치한다. 대기열 지연으로 보인다.

## 벤치마크 데이터 실측

- **AA 무료 API**(사용자 키): 200, `X-Aa-Tier: free`, 200개씩 4페이지. 1페이지 기준 `intelligence_index` 39/200, coding·agentic 0.
- **OpenRouter Benchmarks**(AA 출처 175행): `intelligence_index` 56, **`coding_index` 151, `agentic_index` 107**. AA 무료 API에서 null인 coding·agentic 지수를 OpenRouter가 제공한다. OR 자체 평가: `gpqa_diamond` 145, `tau_bench_verified_airline` 142. `meta.citation`이 있다.
- OpenRouter whitelist 18개 기반 모델 중 12개가 OR 벤치마크에 등장한다(앞부분 일치 기준이며, 정확한 Identity 매핑은 Phase 1에서 한다).

## 설계 영향

1. 외부 플러그인은 V1 전용이다. `host/v2-promise.ts`는 제거하고, 향후 OpenCode가 외부 V2를 지원하면 다시 검토한다.
2. 선택자 = `chat.message` 모델 교체(E3), 관측 = `event` + `chat.headers`(E9), 하위 에이전트 = `session.created.parentID`(E6).
3. 공급자 모델 갱신 = `config` hook 메모리 내 주입(E2). 설정 파일은 쓰지 않는다.
4. 같은 요청 내 전환은 제외한다(E5). 장애 대응은 OpenCode 재시도(E7)와 다음 턴 전환으로 한다.
5. OR Benchmarks를 C/A의 주 출처로 쓴다. AA 무료 API는 I와 속도 사전값을 맡는다.
6. 선택자가 동작하지 않을 때의 가드(`oamp` baseURL 연결 거부)는 OpenCode 재시도 때문에 **약 65초 뒤에** 실패한다. 즉시 실패시키는 수단은 V1에 없다. 선택자는 후보가 없어도 항상 하나를 고르도록 한다(최후 수단 = Health를 무시한 최고 점수 경로).

## 미확인·후속

- E11 토스트 실동작(TUI 세션에서 확인).
- `config` hook으로 주입한 모델에 `cost`·`limit` 메타데이터를 넣었을 때 OpenCode 표시와 compaction 동작.
- 💡 후보(E12): 재시도 이벤트(`session.status retry`) 감지 → `session.abort` → 다음 경로로 "continue" 프롬프트를 보내는 턴 내 전환. 실패한 단계는 출력이 없어 중복 부작용이 없다. 다만 사용자에게 보이는 메시지가 추가되고 CLI(`opencode run`) 동작에 영향이 있을 수 있어 Phase 4에서 별도로 실험한다.
