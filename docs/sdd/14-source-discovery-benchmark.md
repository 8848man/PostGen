# Source Discovery Benchmark

이 문서의 수치는 **2026-10-26 당시 파일 해시**에 묶인 측정 기록이다. 2026-10-27에는 내부 승인 심사 세션 제외 규칙이 추가되어 현재 구현의 성능 측정값으로 재사용하지 않는다.

## 탐색 성능과 검증 범위

후보 탐색 성능은 `tests/source.test.mjs`의 선택형 합성 벤치마크로 측정합니다. 이 벤치마크는 `POSTGEN_BENCH`를 지정할 때만 실행되며, Codex·Claude Code 형식의 합성 JSONL을 `POSTGEN_BENCH_MB`(기본 128) MiB 이상 만들어 현재 작업 폴더와 다른 폴더 8개에 나눠 연결합니다. 실행마다 새 Node 프로세스에서 Git 탐색을 끄고(`includeGit: false`) 검색어 `deploy rollback`, 후보 상한 100으로 `discover`를 호출합니다. 벤치마크 측정값은 `node --test`의 진단(`#` 줄)에 JSON으로 출력됩니다. 먼저 Node.js 버전, OS(`platform`·`release`·`arch`), 입력 크기(`inputBytes`)와 파일 수(`inputFiles`), 탐색 옵션, 현재 `collect.mjs`·`source-providers.mjs`의 SHA-256을 한 줄로 남깁니다. 이어 실행별 원자료로 `implementation`, `round`, `performance.now()` 기준 시간(`elapsedMs`), `process.resourceUsage().maxRSS`(`maxRssKb`, KiB), 후보 목록(`candidates`)을 남깁니다. 구현별 집계에는 `implementation`, `source`, `inputBytes`, `runs`, 시간 중앙값(`elapsedMsMedian`), 최대 RSS 중앙값(`maxRssKbMedian`)과 최댓값(`maxRssKbHighest`), 현재 작업 폴더 후보 수(`total`)가 들어가며, `candidateListsStableAcrossRuns`가 함께 출력됩니다. 반복 실행 사이에 후보 수나 목록이 달라지면 테스트가 실패합니다. 마지막 줄은 비교가 실행되면 `comparison: "available"`, `comparisonSucceeded`, `candidateListsEqual`, `currentTotal`, `baselineTotal`이고, 비교할 수 없으면 `status: "comparison unavailable"`, `comparisonSucceeded: false`와 사유(`reason`)입니다.

### 2026-10-26 현재 구현 단독 측정

`2026-10-26 22:41 KST`에 아래의 32 MiB·3회 명령을 실행했습니다. 환경은 Windows `win32` / `10.0.26200` / `x64`, Node.js `v22.18.0`입니다. 합성 JSONL은 32파일, 33,666,007바이트였고, 현재 작업 폴더와 다른 폴더 8개에 분산되었습니다. 모든 실행은 `includeGit: false`, `query: "deploy rollback"`, `limit: 100`으로 별도 Node 프로세스에서 탐색했습니다. 측정한 작업 파일의 SHA-256은 `collect.mjs` = `be326fba218e33331ceeb7cdc3c711e248fd8d242f49f170bf378f3443c6245a`, `source-providers.mjs` = `50d61a117bb98e0f347c14da8b86f8c79ebe4e34545e7293ac07440a6c2a23e2`입니다. 이 해시는 현재 작업 파일을 식별하며 변경 전 커밋의 해시가 아닙니다.

| 구현 | 실행 | `elapsedMs` | `maxRssKb` (KiB) | 후보 수 |
| --- | ---: | ---: | ---: | ---: |
| 현재 | 1 | 279.8575 | 74,752 | 14 |
| 현재 | 2 | 184.5110 | 78,072 | 14 |
| 현재 | 3 | 215.1041 | 78,372 | 14 |
| 변경 전 | — | 미측정 | 미측정 | 미측정 |

현재 구현의 진단 집계값은 `source: "working tree"`, `inputBytes: 33666007`, `runs: 3`, `elapsedMsMedian: 215.1041`, `maxRssKbMedian: 78072` KiB, `maxRssKbHighest: 78372` KiB, `total: 14`입니다. 세 실행의 후보 **전체 목록**이 같아 `candidateListsStableAcrossRuns: true`였습니다. 목록 순서의 `sourceId`는 `1152a5013af5a13f`, `0f2121c725a72149`, `a9321fb9e0a5f3ab`, `1d328fd73dbbe006`, `907def6152d39c41`, `d31db1a50219cc9b`, `f3d56777078dbb42`, `75faebf024512b65`, `63e52161afddd4ee`, `562c7b6d886ec227`, `2ccdf98fc64a0a64`, `ed2d968be425f384`, `aa6613aa4c0cd0e2`, `9b2250e33892bbf7`입니다.

같은 명령을 다시 실행한 현재 구현 단독 측정의 원자료는 다음과 같습니다. 입력은 다시 32파일·33,666,007바이트였고 Node.js·OS·검색 옵션과 두 작업 파일의 SHA-256은 위 측정과 같았습니다. 각 실행은 새 Node 프로세스입니다.

| 구현 | 재실행 회차 | `elapsedMs` | `maxRssKb` (KiB) | 후보 수 |
| --- | ---: | ---: | ---: | ---: |
| 현재 | 1 | 291.8213 | 77,432 | 14 |
| 현재 | 2 | 146.8108 | 78,492 | 14 |
| 현재 | 3 | 121.8852 | 78,756 | 14 |

재실행 진단의 집계값은 `source: "working tree"`, `inputBytes: 33666007`, `runs: 3`, `elapsedMsMedian: 146.8108`, `maxRssKbMedian: 78492` KiB, `maxRssKbHighest: 78756` KiB, `total: 14`, `candidateListsStableAcrossRuns: true`입니다. 재실행 세 번의 후보 전체 목록은 서로 같았고, `sourceId` 14개의 순서는 위 측정에 기록된 순서와 같았습니다. 최초 세 실행의 시간 범위는 184.5110~279.8575 ms(폭 95.3465 ms), 최대 RSS 범위는 74,752~78,372 KiB(폭 3,620 KiB)입니다. 재실행 세 실행의 시간 범위는 121.8852~291.8213 ms(폭 169.9361 ms), 최대 RSS 범위는 77,432~78,756 KiB(폭 1,324 KiB)입니다. 두 측정의 중앙값 차이는 시간 68.2933 ms, 최대 RSS 420 KiB로, 실행 간 변동을 보여줍니다. 이 숫자는 고정 성능이나 변경 전후 개선량이 아닙니다.

### 2026-10-26 현재 구현 추가 측정

`2026-10-26 23:06 KST`에 아래의 32 MiB·3회 명령을 다시 실행했습니다. 32파일·33,666,007바이트 입력, Windows `win32` / `10.0.26200` / `x64`, Node.js `v22.18.0`, `includeGit: false`, `query: "deploy rollback"`, `limit: 100`이었고, 두 작업 파일의 SHA-256은 위의 두 측정과 같습니다. 각 실행은 별도 Node 프로세스에서 이루어졌습니다.

| 구현 | 실행 | `elapsedMs` | `maxRssKb` (KiB) | 후보 수 |
| --- | ---: | ---: | ---: | ---: |
| 현재 | 1 | 383.7774 | 76,032 | 14 |
| 현재 | 2 | 116.5136 | 78,524 | 14 |
| 현재 | 3 | 125.6215 | 78,016 | 14 |

진단 집계값은 `implementation: "current"`, `source: "working tree"`, `inputBytes: 33666007`, `runs: 3`, `elapsedMsMedian: 125.6215`, `maxRssKbMedian: 78016` KiB, `maxRssKbHighest: 78524` KiB, `total: 14`, `candidateListsStableAcrossRuns: true`입니다. 세 실행의 후보 전체 목록은 서로 같았고 위에 기록한 `sourceId` 14개의 순서도 같았습니다. 벤치마크는 `{"status":"comparison unavailable","comparisonSucceeded":false,"reason":"previous implementation source is unconfirmed: provide baseline directory, full Git commit ID, and SHA-256 digests for collect.mjs and source-providers.mjs"}`로 끝났습니다. 세 실행의 시간 범위는 116.5136~383.7774 ms로, 현재 구현의 측정값도 실행마다 달라집니다.

변경 전 전체 커밋 ID와 두 파일의 SHA-256은 **미확인**입니다. 이 격리 작업 폴더에 `.git`이 없고 `git status`, `git rev-parse --show-toplevel`, `git remote -v`가 모두 `fatal: not a git repository (or any of the parent directories): .git`를 반환했습니다. 따라서 현재 폴더의 Git 이력, `origin` 설정, 원격 커밋과 푸시 여부를 확인할 수 없고 변경 전 구현도 실행할 수 없습니다. 이번 README 작업에서는 원격 설정이나 푸시를 수행하지 않았으며, **CEO가 요청한 GitHub 푸시는 미완료**입니다. **변경 전후 후보 목록 동일성, 시간·최대 RSS 개선 여부는 미확인**이며, 현재 구현 단독 수치로 개선을 주장하지 않습니다. 이전 README의 285 ms·77 MiB 수치는 대응하는 원자료가 없어 이 측정과 합치지 않았습니다. 확인된 변경 전 Git 작업 트리가 준비되면 아래 네 값을 검증해 같은 명령을 다시 실행해야 비교 표를 완성할 수 있습니다.

같은 입력으로 두 구현을 비교하려면 변경 전 `collect.mjs`와 `source-providers.mjs`가 커밋된 Git 작업 트리를 준비하고, 실행 전에 다음 네 값을 모두 지정합니다. `POSTGEN_BENCH_BASELINE`에는 그 저장소 루트(`skill/postgen/scripts`를 찾아 씀)나 두 파일이 있는 `scripts` 디렉터리를 지정합니다. 커밋 ID는 40~64자리 16진수, SHA-256은 64자리 16진수여야 합니다. 값이 빠지거나 형식이 틀리거나, 파일이 없거나, `HEAD`가 선언한 커밋과 다르거나, 두 파일이 추적되지 않거나 커밋되지 않은 변경이 있거나, 선언·커밋·작업 파일의 SHA-256이 일치하지 않거나, 현재 구현과 바이트 단위로 같으면 변경 전 구현을 실행하지 않고 현재 구현 측정과 `comparison unavailable` 진단만 출력합니다. 비교가 실행되면 두 구현을 라운드마다 순서를 바꿔 같은 입력으로 실행하고, 후보 목록이나 후보 수가 다르면 테스트가 실패합니다.

```powershell
$env:POSTGEN_BENCH_BASELINE = '<변경 전 scripts 디렉터리>'
$env:POSTGEN_BENCH_BASELINE_SOURCE = '<변경 전 전체 Git 커밋 ID>'
$env:POSTGEN_BENCH_BASELINE_COLLECT_SHA256 = '<collect.mjs의 SHA-256>'
$env:POSTGEN_BENCH_BASELINE_PROVIDERS_SHA256 = '<source-providers.mjs의 SHA-256>'
```

벤치마크는 입력을 임시 디렉터리에 만들고 종료 시 삭제합니다. `POSTGEN_BENCH_MB`를 생략하면 128 MiB 입력을 만들고, `POSTGEN_BENCH_RUNS`를 생략하면 3회 실행합니다(1~20만 허용). 아래 예시는 32 MiB 입력을 3회 탐색하며, 변경 전후를 비교할 때는 두 구현에 같은 값을 사용합니다.

```powershell
$env:POSTGEN_BENCH = '1'
$env:POSTGEN_BENCH_MB = '32'
$env:POSTGEN_BENCH_RUNS = '3'
node --test --test-name-pattern=benchmark tests/source.test.mjs
```

합성 회귀 테스트는 작업 폴더 격리, 완료 메시지 선별, Codex·Claude Code 혼합 후보 목록, 손상되거나 형식이 바뀐 줄, 탐색 뒤 다른 폴더로 옮겨진 기록 제외, 출처 위치·읽기 한도·잘림 진단 등 수집 동작을 검사합니다. 이는 실제 기록으로 작성한 글의 게시 가능성이나 사실 오류율을 검증한 결과가 아닙니다. **실제 사용자 기록을 바탕으로 여러 주제의 초안을 사람이 평가하는 파일럿은 수행하지 않았으므로 글 품질은 미검증입니다.** 실제 기록에 대해서는 기본 생성 흐름의 동작과 본문을 출력하지 않는 후보 목록 호출만 확인했고 초안 품질은 평가하지 않았으며, 실제 혼합 프로젝트의 글 생성 품질·토큰 사용량·출처 누락 여부도 측정하지 않았습니다. 기존 환경 검증의 범위는 [환경·검증 기록](00-environment.md)을 참고하세요.

