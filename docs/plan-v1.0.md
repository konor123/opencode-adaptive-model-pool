# OpenCode Adaptive Model Pool (OAMP) 개발 계획

- 버전: v1.0
- 작성일: 2026-11-10
- 기반: FMR(Free-Model-Router)의 성능·속도 통합 평가 방식
- 목표 환경: OpenCode V2, TypeScript 플러그인, 다중 모델 공급자

## 1. 개발 목표

OpenCode에 연결된 여러 공급자의 모델 카탈로그를 지속적으로 추적하고, 공개 벤치마크와 실제 사용 시 측정한 응답속도를 결합하여 모델의 우선순위를 동적으로 결정한다. 모델 또는 공급자가 실패하면 정상 경로로 전환하고, 상태 회복 시 평가를 거쳐 풀에 재편입한다.

### 핵심 요구사항

1. 공급자별 모델 추가·삭제·변경을 자동 발견한다.
2. 모델 **능력(기반 모델)**과 **실행 품질(공급자·엔드포인트별 경로)**을 별도로 평가한다.
3. 공개 코딩·에이전트·추론 벤치마크를 수집하고 출처·버전·평가 환경을 보존한다.
4. TTFA, 전체 요청시간, 출력속도, 실패율을 실제 OpenCode 트래픽에서 측정한다.
5. FMR의 성능 70% / 속도 30% 통합 점수를 초기 정책으로 적용한다.
6. 작업 요구조건을 충족하는 후보만 선택하고 순위를 재계산한다.
7. Rate Limit·타임아웃·공급자 장애 시 대체 경로를 사용한다.
8. 수동 모델 선택, 세션 일관성, 유료 모델 사용 정책을 우선 보장한다.
9. 평가 데이터가 없는 신규 모델도 제한된 탐색을 통해 안전하게 편입한다.

### 초기 범위

- 코딩 에이전트의 일반 작업과 도구 호출을 중심으로 한다.
- 사용자의 기존 공급자 설정과 인증정보는 변경하지 않는다.
- 플러그인은 기존 OpenCode 구동방식을 유지한 채 설치·제거할 수 있어야 한다.
- 모델 선택·재시도·벤치마크 수집은 각각 독립 모듈로 구현한다.
- 유료 모델은 명시적으로 허용한 경로만 사용한다. **Open-source 모델과 무료 API를 동일하게 취급하지 않는다.**

## 2. 운영 대상 공급자

| 공급자 ID | 현재 연결 경로 | 모델 목록 수집 방안 | 경로별 측정 |
|---|---|---|---|
| `exaone` | `https://api.exaone.ai/v1` | OpenCode 등록 모델 + `/models` 호환 여부 확인 | 개별 측정 |
| `xkiro` | `https://api.xkiro.com/v1` | OpenCode 등록 모델 + `/models` 호환 여부 확인 | 개별 측정 |
| `opencode` | OpenCode 제공 모델 | OpenCode 활성 카탈로그 | 개별 측정 |
| `openrouter` | OpenRouter | OpenCode 카탈로그 + OpenRouter 모델·벤치마크 API | 개별 측정 |
| `nvidia` | NVIDIA 호스팅 모델 | OpenCode 카탈로그 + NVIDIA 모델 목록 확인 | 개별 측정 |

- OpenCode의 **실제로 활성화된 모델**을 풀 편입의 1차 기준으로 한다.
- 공급자 API의 `/v1/models`는 존재·권한·응답 형식을 확인한 후에만 사용한다.
- 카탈로그에 나타나더라도 계정 권한, 잔여 한도, 기능 부족으로 요청에 실패할 수 있다.
- `provider/model[#variant]`를 실행 가능한 경로의 식별자로 사용한다.

## 3. 시스템 아키텍처

```text
OpenCode Model Registry ───────┐
Provider Catalog Adapters ─────┤
                               ▼
                        Model Discovery
                               │
                               ▼
                       Model Identity Map
                               │
         ┌─────────────────────┴─────────────────────┐
         ▼                                           ▼
Benchmark Ingestion                         Route Telemetry
(OpenRouter, AA,                             (OpenCode 실제 요청,
 SWE, Terminal, MCP 등)                       주기적 Probe)
         │                                           │
         ▼                                           ▼
Canonical Performance Score                Provider/Route Health
         └─────────────────────┬─────────────────────┘
                               ▼
                    Scoring & Pool Manager
                               │
                   Capability / Cost Filter
                               ▼
                       Dynamic Ranking
                               │
                     Selection / Fallback
                               ▼
                    OpenCode Agent Session
```

### 모듈 구성

| 모듈 | 책임 |
|---|---|
| `discovery` | 모델·공급자 목록 동기화, 신규·폐지 모델 감지 |
| `identity` | 공급자별 모델 명칭을 기반 모델 및 변형 모델에 대응 |
| `benchmarks` | 외부 성능 데이터 수집·정규화·중복 출처 제거 |
| `telemetry` | 실제 요청 지연·출력량·완료상태·실패율 기록 |
| `scoring` | 성능·속도·신뢰도 점수 계산 및 정렬 |
| `health` | 장애 분류, Circuit Breaker, Cooldown, 회복 검사 |
| `routing` | 작업 조건·수동선택·세션 상태에 따른 모델 선택 |
| `fallback` | 지원 가능한 범위에서 대체 경로로 재실행, 중복 실행 방지 |
| `storage` | SQLite 기반 영속 저장, 이력·데이터 출처 관리 |
| `commands` | 순위·점수·경로 상태·검사 결과 조회 및 정책 변경 |

## 4. 벤치마크 데이터 소스

### 4.1 자동 수집 1차 소스

| 우선순위 | 출처 | 주요 데이터 | 인터페이스 | 권장 갱신 |
|---|---|---|---|---|
| 1 | OpenRouter Benchmarks | Coding / Agentic / Intelligence 지수, 모델 식별자, 출처 | `GET https://openrouter.ai/api/v1/benchmarks` | 12~24시간 |
| 2 | Artificial Analysis Data API v2 | Intelligence / Coding / Agentic, 공개 성능·속도 요약 | `GET https://artificialanalysis.ai/api/v2/language/models/free` | 24시간 |

- OpenRouter Benchmarks API: Bearer 인증. 문서상 분당 30회·일당 500회 한도.
- Artificial Analysis Free API: `x-api-key` 인증. 문서상 24시간 윈도 기준 100회 한도.
- OpenRouter에서 Artificial Analysis를 재공급한 점수는 **같은 평가 결과로 간주**하여 중복 가중하지 않는다.
- API가 제공하지 않는 개별 벤치마크·공급자별 지표는 임의로 추론하지 않는다.
- 출처 이용조건 및 Attribution 요구를 데이터 표시부에 반영한다.

### 4.2 전문 벤치마크 보강 소스

| 출처 | 평가 대상 | OAMP 내 위치 | 데이터 편입 방식 |
|---|---|---|---|
| SWE-bench Pro V2 | 실제 저장소 문제 해결 | Coding 핵심 | 공개 리더보드·결과 수집 어댑터 |
| SWE Atlas v1.1 | Codebase Q&A, 테스트 작성, 리팩터링 | Coding 보강 | 버전 지정 스냅샷 |
| Terminal-Bench 4.0 | 터미널 기반 장기 에이전트 작업 | Agentic 핵심 | 버전·Harness 단위 결과 |
| MCP Atlas | MCP 도구 탐색·호출·복합 작업 | Agentic 보강 | 공개 평가 결과 연동 |
| BFCL | 함수·도구 호출 정확도 | Agentic 보조 | 버전 고정·품질 가중치 적용 |
| LiveCodeBench | 알고리즘 코딩 능력 | Coding 보조 | 평가 기간·문항 구간별 |
| LiveBench | 광범위 추론·지시 수행 | Reasoning 보조 | 세부 평가별 |

**비교 원칙**

- 벤치마크 원점수는 서로 직접 더하지 않는다. 지표 방향·스케일·평가 모집단을 기준으로 0~100으로 정규화한다.
- 벤치마크 버전이 바뀌면 독립 시계열로 저장한다. 예: SWE Atlas v1.0과 v1.1 결과를 같은 수치처럼 비교하지 않는다.
- 모델, Reasoning Effort, Harness, 설정값, 평가일이 다르면 별도 측정치로 취급한다.
- 동일 출처의 종합지표와 이를 구성하는 개별 지표가 동시에 있을 때는 중복 반영하지 않는다.
- 특정 전문 벤치마크의 데이터 수집이 자동화되지 않으면 캐시된 최신 검증 스냅샷을 사용한다.
- 외부 벤치마크 커버리지가 낮은 무료·소형 모델은 OAMP 자체 경량 평가 결과로 보강한다.

## 5. 모델 식별과 데이터 계약

### 5.1 분리할 식별자

- `canonical_model_id`: 기반 모델의 능력 점수를 공유하는 식별자.
- `model_variant_id`: 추론 강도·버전·양자화·컨텍스트 구성 등 능력 차이가 있는 변형.
- `route_id`: `providerID + modelID + variant + endpoint_fingerprint`.
- `benchmark_result_id`: `source + benchmark + version + harness + model_variant_id + effort + evaluated_at`.

서로 다른 공급자에서 동일 모델을 제공하더라도 **성능 점수는 조건부로 공유**하고, 속도·오류·가격·한도는 `route_id` 단위로 분리한다. 접미사만 유사한 모델명은 자동으로 동일 모델에 합치지 않는다.

### 5.2 저장 항목

```text
models          : canonical ID, 계열, 출시·수정 시각, 기능, 평가 신뢰도
model_aliases   : provider별 원본 ID, canonical 매핑, 매핑 신뢰도
routes          : 공급자, 엔드포인트 지문, 원본 모델 ID, variant, 비용, 활성 상태
benchmarks      : 출처, 원점수, 정규화 점수, 버전, harness, effort, 수집 시각
request_metrics : route, 작업 유형, 입력/출력 토큰 구간, TTFA, E2E, TPS, 상태
health_states   : 실패 원인, 최근 오류율, cooldown 종료, 재진입 상태
scores          : 성능, 속도, 신뢰도, 최종 점수, 계산 시각
rank_history    : 작업 유형, 순위, 선택 사유, 이전 순위
policy          : 모델 허용·차단, 비용 상한, 강제 고정, 최소 기능, 탐색 비율
```

원문 프롬프트, 응답 본문, 인증 토큰은 기본 저장 대상에서 제외한다.

## 6. 성능 점수: FMR Scoring Engine 개편

### 6.1 1차 상위 가중치

기존 FMR 정책을 초기값으로 유지한다.

\[
P = 0.55C + 0.30A + 0.15I
\]

- `C` = Coding Score
- `A` = Agentic Score
- `I` = Reasoning / Intelligence Score

### 6.2 세부 가중치 초안

| 분류 | 세부 지표 | 분류 내부 가중치 |
|---|---|---:|
| Coding | SWE-bench Pro V2 | 45% |
| Coding | SWE Atlas v1.1 | 35% |
| Coding | LiveCodeBench | 20% |
| Agentic | Terminal-Bench 4.0 | 55% |
| Agentic | MCP Atlas | 30% |
| Agentic | BFCL | 15% |
| Reasoning | Artificial Analysis의 독립 추론지표 / LiveBench 추론 영역 | 데이터 가용성에 따라 정규화 |

- 위 가중치는 **초기 가설**이며 개발 후 실제 OpenCode 작업 성공률과의 상관관계로 재보정한다.
- 세부 평가값이 없으면 사용 가능한 독립 지표에 한해 가중치를 재정규화한다.
- 특정 영역의 근거가 사실상 전무하면 그 영역은 중립 사전값과 낮은 신뢰도를 적용한다.
- 개별 평가가 부족하면 OpenRouter·Artificial Analysis 종합지표를 **대체 데이터**로 사용한다.

### 6.3 신뢰도 보정

\[
P_{effective} = cP + (1-c)50, \quad 0 \le c \le 1
\]

`c`는 데이터 커버리지, 출처 독립성, 최근성, 모델 ID 매칭 확실성, 실제 작업 검증량으로 산정한다. 신규·미평가 모델이 단일 높은 점수로 상위권에 진입하는 현상을 줄인다.

### 6.4 자체 성능 평가

외부 데이터가 없는 모델을 위해 소규모 검증 세트를 운영한다.

1. TypeScript/Python 코드 오류 수정과 테스트 통과 여부.
2. 여러 파일을 수정하는 소형 저장소 작업.
3. 정해진 스키마의 Tool Call 생성과 인자 정확도.
4. 실패한 테스트 결과를 받아 수정하는 재시도 작업.
5. 각 작업의 성공 여부·소요시간·요청 수·토큰 사용량 수집.

동일한 OpenCode Harness, 프롬프트, 실행 제한과 검증기로 모델을 비교한다. 평가 실행 결과는 공개 벤치마크와 별도 출처로 저장한다.

## 7. 속도 점수: 경로별 실측 우선

### 7.1 측정 지표

| 지표 | 정의 | 적용 |
|---|---|---|
| TTFT | 첫 토큰 수신까지의 시간 | 진단 지표 |
| TTFA | 첫 유효 답변 또는 Tool Call 시작까지의 시간 | 상호작용 속도 |
| E2E | 단일 모델 요청 완료까지의 시간 | 주 속도 지표 |
| TPS | 출력 토큰/생성시간 | 처리량 |
| Task Time | 다중 요청·도구 실행 포함 작업 종료까지의 시간 | 정책 사후 검증 |
| Error / Rate Limit | 429·5xx·타임아웃 등 | Health 판정 |

- OpenCode의 `primary` 모델 요청과 `title`·`compaction`·`generate` 같은 보조 요청을 구분한다.
- 입력 길이(예: 0~2k, 2~16k, 16~64k, 64k+) 및 출력 규모·Reasoning Effort 별로 비교한다.
- 동일 모델의 다른 공급자 경로는 별도 지연 분포를 유지한다.
- TTFA를 관측할 수 없는 프로토콜은 값을 결측으로 남기고 E2E를 우선 사용한다.
- 외부 서비스의 속도 수치는 초기 사전값으로 사용하고 실제 사용자 트래픽 수치가 쌓이면 대체한다.

### 7.2 초기 속도 점수

\[
L = 0.35S_{TTFA} + 0.45S_{E2E} + 0.20S_{TPS}
\]

- 각 `S`는 같은 작업·토큰 구간에서 0~100으로 환산하며, 낮은 지연과 높은 TPS에 높은 점수를 부여한다.
- 정규화 기준은 현재 후보 집합의 최솟값/최댓값이 아닌 **고정된 기준 분포**로 관리하여 모델 추가·삭제 시 점수 흔들림을 줄인다.
- 실측값은 EWMA(`alpha = 0.25` 초기값)와 최근 p50/p95를 병행 보존한다.
- 긴 작업에서는 토큰 수·Reasoning 양이 E2E를 좌우하므로 Task Time과 작업 성공률을 별도 검증 지표로 추적한다.

### 7.3 샘플이 적은 경로

- 신규 모델은 카탈로그·외부 기준값을 사전값으로 사용한다.
- Tool Calling 지원과 비용 정책을 검증한 뒤 제한된 Probe만 수행한다.
- 낮은 표본 수에서는 실제 지연 수치의 영향력을 점진적으로 늘린다.
- Probe 측정치와 일반 요청 측정치를 분리 저장한다.
- 탐색 비율(`exploration_budget`)을 제한하여 작업 품질 저하를 억제한다.

## 8. 최종 라우팅 점수와 우선순위

\[
R = 0.70P_{effective} + 0.30L
\]

### 선택 순서

1. 현재 프로젝트·계정에서 사용 가능한 모델만 후보로 수집한다.
2. 작업 유형에 따라 Tool Calling, Context, 모달리티, 출력 지원 여부를 검사한다.
3. 가격·사용량·사용자 차단 정책을 적용한다.
4. 장애 및 Cooldown 중인 경로를 제외한다.
5. 남은 후보의 `R`을 계산한다.
6. 동점·근접 점수에서는 최근 p95, 실패율, 공급자 분산 순으로 정한다.
7. 선택 결과와 선정 근거를 기록한다.

### 순위 안정화

- 순위 역전은 최소 점수 차(`switch_margin`) 또는 일정 지속시간을 만족할 때 반영한다.
- 진행 중 작업·도구 실행 중에는 임의로 모델을 전환하지 않는다.
- 작업별 Pool(`coding`, `agentic`, `fast`)은 향후 개별 가중치를 지원하도록 설계한다.
- 모델을 직접 선택한 사용자는 자동 선정 대상에서 제외한다. 수동 고정 해제 시 자동 순위를 복원한다.

## 9. 장애 대응과 Fallback

### 9.1 오류 분류

| 상태 | 처리 |
|---|---|
| 429 Rate Limit | 경로별 Cooldown, `Retry-After` 우선 사용 |
| 5xx / 네트워크 장애 | 짧은 재시도 후 대체 공급자 후보 검토 |
| Timeout | 요청 상태 확인 후 대체 경로 검토 |
| 401 / 403 | 인증·권한 문제로 경로 비활성화, 자동 반복 중단 |
| Context Overflow | Context 축약 또는 더 큰 Context 모델 선정 |
| 400 / 모델 미지원 | 해당 모델·기능 조합 제외, 무조건 재시도 금지 |
| 부분 응답 후 실패 | 메시지·도구 실행 상태를 검사하여 중복 실행 방지 |

### 9.2 안전한 실행 규칙

- 한 작업에서 최대 4개 경로, 요청별 전환 총예산 30초를 초기 설정값으로 둔다.
- 동일 요청의 Tool Call이 이미 외부 상태를 변경했다면 자동으로 처음부터 재실행하지 않는다.
- 모델 전환 후 필요한 세션 메시지·도구 결과가 보존되는지 검증한다.
- 순환형 Fallback을 방지하기 위해 요청별 시도 경로 집합을 유지한다.
- Cooldown 만료 모델은 제한된 복구 시험 후 다시 정상 Pool에 넣는다.
- 전체 경로가 실패하면 마지막 오류와 시도 내역을 반환하고 반복 시도를 중단한다.

### 9.3 OpenCode V2 연동 방식

공식 플러그인 API 기준으로 다음을 사용한다.

| API·Hook | 용도 |
|---|---|
| `ctx.model.list()` | 현재 활성 모델 조회 |
| `ctx.model.transform()` / `ctx.model.reload()` | 모델 허용정책·카탈로그 반영 |
| `ctx.session.switchModel()` | 후속 요청의 선택 모델 변경 |
| `ctx.session.hook("prompt", ...)` | 요청 진입점의 라우팅 정책 연동 검토 |
| `ctx.session.hook("context", ...)` | 호출 직전 컨텍스트·옵션 관측 및 조정 |
| `ctx.session.hook("http.request", ...)` / `http.response` | HTTP 기반 지연·상태 관측 |
| `ctx.session.hook("retry", ...)` | 동일 경로 재시도 여부·지연 제어 |

**구현 경계:** 공식 `retry` Hook은 재시도 결정과 지연을 제어하며, 그 Hook 자체에서 다음 시도의 모델을 변경하는 계약은 제공하지 않는다. 따라서 *실패한 요청의 즉시 자동 모델 전환*은 별도 오케스트레이션 어댑터의 가능성을 먼저 검증한다. 이를 확인하기 전에는 “다음 요청부터 최상위 정상 모델 사용”까지를 확정 기능으로 둔다.

## 10. 갱신 및 저장 정책

| 대상 | 초기 주기 | 조건 |
|---|---|---|
| OpenCode 활성 카탈로그 | 시작 시 + 6시간 | 수동 새로고침 제공 |
| 사용자 지정 공급자 모델 API | 6시간 | 지원 공급자만 호출 |
| OpenRouter Benchmarks | 12~24시간 | ETag·변경시각 고려 |
| Artificial Analysis | 24시간 | 응답 캐시·요청 한도 준수 |
| 전문 벤치마크 스냅샷 | 7일 | 신규 버전 발견 시 분리 저장 |
| 실측 성능·Health | 각 요청 종료 시 | EWMA·p95 갱신 |
| Pool 재정렬 | 유의미한 점수·상태 변화 시 | Hysteresis 적용 |
| 경로 복구 검사 | Cooldown 종료 시 | 요청량·비용 상한 준수 |

- 특정 카탈로그에서 모델이 한 번 누락되어도 즉시 삭제하지 않고 상태를 `stale`로 변경한다.
- 반복 확인에서 삭제가 확정되면 활성 풀에서 제외하되 측정 이력은 보존한다.
- API 수집 실패 시 마지막 정상 스냅샷을 유지한다.
- 데이터베이스는 SQLite로 시작하며 파일 잠금, 원자적 갱신, 스키마 버전 관리를 적용한다.

## 11. 설정 인터페이스 설계

다음은 구현할 플러그인의 **목표 설정 스키마 예시**이다. 실제 옵션 이름은 코딩 단계에서 확정한다.

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/oamp",
      "options": {
        "enabled": true,
        "providers": ["exaone", "xkiro", "opencode", "openrouter", "nvidia"],
        "policy": {
          "allowPaid": false,
          "allowUnknownPrice": false,
          "requireToolCalling": true,
          "manualSelectionWins": true,
          "maxRoutesPerRequest": 4,
          "failoverBudgetMs": 30000,
          "explorationBudget": 0.05
        },
        "weights": {
          "performance": 0.70,
          "latency": 0.30,
          "coding": 0.55,
          "agentic": 0.30,
          "reasoning": 0.15
        },
        "latency": {
          "ttfa": 0.35,
          "e2e": 0.45,
          "tps": 0.20,
          "ewmaAlpha": 0.25
        },
        "refresh": {
          "catalogHours": 6,
          "benchmarkHours": 24
        }
      }
    }
  ]
}
```

`allowPaid=false`는 무료 경로로 명확히 확인된 경우만 사용한다는 의미이며, 비용 정보가 없는 모델은 무료로 간주하지 않는다.

### 제공할 명령

- `oamp status`: 현재 공급자·풀·수집 상태.
- `oamp rank [pool]`: 점수, 순위, 신뢰도, 선택 사유.
- `oamp model <provider/model>`: 벤치마크·실측 상세.
- `oamp refresh`: 카탈로그와 벤치마크 수동 갱신.
- `oamp probe [model]`: 신규 경로의 기능·지연 검사.
- `oamp pin/unpin`: 자동 선택 일시 해제 및 복원.
- `oamp history`: 순위 변화와 장애 전환 이력.

명령의 실제 등록 위치(플러그인 Command·CLI·TUI)는 OpenCode V2 제공 인터페이스에 따라 결정한다.

## 12. 개발 단계와 산출물

### Phase 0 — API 연동·Fallback 실현성 검증

**작업**

- [ ] OpenCode 버전 고정 및 V2 플러그인 설치·로드 확인.
- [ ] `ctx.model.list` / `model.transform` / `switchModel`의 동작 테스트.
- [ ] TUI·CLI·에이전트별 수동 모델 선택 우선순위 검증.
- [ ] 실패 요청 중 다른 경로로 **즉시 전환 및 안전한 재실행** 가능성 실험.
- [ ] HTTP 및 WebSocket 경로의 TTFA·E2E 측정 가능 범위 조사.
- [ ] 각 공급자의 모델 목록 API·가격 필드·Tool Calling 지원 확인.

**산출물:** `compatibility.md`, 최소 플러그인 실행 PoC, 즉시 Fallback 가능/불가능 판정.

### Phase 1 — Discovery · Identity · Storage

**작업**

- [ ] 5개 공급자 모델 목록 동기화.
- [ ] 모델·변형·경로 ID 정규화.
- [ ] Capability·가격 필터.
- [ ] SQLite 스키마·마이그레이션.
- [ ] 신규·삭제·일시적 조회 실패 상태 처리.

**산출물:** 동적 Model Registry 및 `oamp status` 초안.

### Phase 2 — Benchmark Ingestion · Performance Score

**작업**

- [ ] OpenRouter Benchmarks API 수집기.
- [ ] Artificial Analysis v2 Free API 수집기.
- [ ] 출처 중복 제거·버전·Harness 구분.
- [ ] 전문 벤치마크 스냅샷 어댑터.
- [ ] FMR 상위 가중치 및 Confidence 계산.
- [ ] 점수 근거와 결측값 가시화.

**산출물:** 모델별 정규화 성능 점수 및 출처 이력.

### Phase 3 — Telemetry · Dynamic Ranking

**작업**

- [ ] 요청별 TTFA·E2E·TPS·오류 측정.
- [ ] 입력 길이·작업 유형별 버킷 집계.
- [ ] EWMA 및 p50/p95 계산.
- [ ] 통합 라우팅 점수 계산.
- [ ] 점수 차 임계값·시간 조건을 이용한 순위 안정화.
- [ ] 수동 선택·가격 정책 우선 적용.

**산출물:** 실제 실행 데이터를 반영한 동적 모델 순위.

### Phase 4 — Health · Fallback · Recovery

**작업**

- [ ] 429·5xx·타임아웃·권한 오류 분류.
- [ ] Route별 Cooldown과 Circuit Breaker.
- [ ] Phase 0 결과에 맞는 Fallback 어댑터 구현.
- [ ] 이미 실행된 Tool Call의 중복 실행 차단.
- [ ] 실패 경로 복구 Probe 및 Pool 재진입.
- [ ] 모든 후보 실패 시 종료 처리.

**산출물:** 장애 상황에도 운영 가능한 모델 선택·전환 계층.

### Phase 5 — 자체 평가 · 튜닝 · 패키징

**작업**

- [ ] 공개 벤치마크 미등재 모델용 경량 자체 평가 세트.
- [ ] 품질·속도 가중치와 신뢰도 계수의 상관관계 분석.
- [ ] Score 변경 이력과 재현 가능한 비교 리포트.
- [ ] npm/Git 설치 경로 및 설정 검증.
- [ ] 업데이트·롤백·스키마 업그레이드 검사.

**산출물:** 배포 가능한 OAMP 플러그인 패키지 및 운영 문서.

## 13. 검증 기준

| 테스트 | 통과 조건 |
|---|---|
| 신규 모델 발견 | 카탈로그 갱신 후 자동 후보 등록·기능 검사 |
| 폐지 모델 처리 | 순위에서 제외되고 기존 이력은 유지 |
| 카탈로그 일시 장애 | 마지막 정상 스냅샷으로 계속 동작 |
| 중복 벤치마크 | AA 재배포 점수가 중복 가중되지 않음 |
| 이름 충돌 | 서로 다른 변형 모델이 잘못 합쳐지지 않음 |
| 평가 결측 | 중립 사전값·신뢰도 보정으로 계산 가능 |
| 속도 변화 | 실측 누적에 따라 순위가 변경됨 |
| 순위 흔들림 | 근소한 점수 변동으로 매 요청 모델이 바뀌지 않음 |
| Rate Limit | 해당 경로 Cooldown 및 대체 후보 검토 |
| 부분 Tool 실행 후 장애 | 부작용 있는 Tool이 중복 실행되지 않음 |
| 유료 모델 차단 | 비용 정책상 허용되지 않은 경로는 호출되지 않음 |
| 수동 모델 고정 | 자동 라우터가 선택을 덮어쓰지 않음 |
| 모델 전환 | 세션 기록·도구 결과·작업 맥락 보존 |
| 전 경로 실패 | 정해진 시간·시도 예산 안에서 종료 |
| 프로세스 재시작 | 모델·벤치마크·Health 기록 복원 |

### 성능 평가 지표(KPI)

- `Task Success Rate`: 실제 코딩 작업의 검증 성공 비율.
- `Median/P95 Task Time`: 작업 완료 시간 분포.
- `Valid Tool-Call Rate`: 도구 호출과 인자 정확도.
- `Failover Recovery Rate`: 복구 가능 장애에서의 정상 완료 비율.
- `Fallback Overhead`: 장애 발생 후 정상 요청 재개까지 추가 시간.
- `Routing Regret`: 사후 평가상 더 우수했던 정상 경로와의 성능 차이.
- `Unintended Paid Calls`: 정책 위반 유료 호출 건수(목표 0).
- `Duplicate Side-Effect Calls`: 동일 외부 동작의 중복 실행 건수(목표 0).

## 14. 주요 기술 결정

| 항목 | 초기 결정 |
|---|---|
| 언어 | TypeScript |
| 연동 | OpenCode V2 Server Plugin API |
| 상태 저장 | SQLite |
| 기본 Benchmark | OpenRouter + Artificial Analysis |
| 전문 Benchmark | SWE-bench Pro V2, SWE Atlas v1.1, Terminal-Bench 4.0, MCP Atlas 등 |
| 성능 상위 점수 | Coding 55 / Agentic 30 / Reasoning 15 |
| 최종 점수 | Performance 70 / Latency 30 |
| 경로 실측 | TTFA 35 / E2E 45 / TPS 20 |
| Health | 오류별 Cooldown + Circuit Breaker |
| 랭킹 | 신뢰도 보정 + Hysteresis |
| 우선 정책 | 수동 선택 > 비용·기능·안전 필터 > 자동 점수 순위 |
| 즉시 자동 Fallback | Phase 0에서 API 실현성 검증 후 구현 방식 확정 |

## 15. 공식 자료

### OpenCode

- [OpenCode 모델 설정 및 카탈로그](https://opencode.ai/docs/models)
- [OpenCode CLI 모델 목록과 Refresh](https://docs.dev.opencode.ai/docs/cli/)
- [OpenCode V2 Server Plugin API](https://opencode.ai/docs/build/plugins/server)
- [OpenCode V1 → V2 Plugin Migration](https://opencode.ai/docs/build/plugins/migrate-v1)

### 성능·속도 데이터

- [OpenRouter Benchmarks API](https://openrouter.ai/docs/api/api-reference/benchmarks/get-benchmarks)
- [Artificial Analysis Data API v2](https://artificialanalysis.ai/data-api/docs)
- [Artificial Analysis API Reference](https://artificialanalysis.ai/data-api/docs/reference)

### 전문 평가

- [SWE-bench Pro V2](https://labs.scale.com/leaderboard/swe_bench_pro_public_v2)
- [SWE Atlas v1.1](https://labs.scale.com/leaderboard/swe-atlas)
- [Terminal-Bench](https://www.tbench.ai/)
- [MCP Atlas](https://labs.scale.com/leaderboard/mcp_atlas)
- [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html)
- [LiveCodeBench](https://github.com/LiveCodeBench/LiveCodeBench)
- [LiveBench](https://livebench.ai/)
