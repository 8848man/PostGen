# Architecture

## 목표 구성

`선택 Source Provider → SourceBundle → EvidencePlan → 계정별 생성 → 품질 점검 → 계정별 최종본·시각 승인 → MCP/Browser 예약 등록 → 플랫폼 공개 → 결과 확인`

| 계층 | 책임 |
| --- | --- |
| Local Core | 계정·샘플·자산·출처·초안·승인·예약의 버전형 저장과 잠금, 보관 정책 |
| Source Provider | AI 기록, 텍스트/파일, URL, 연결 문서의 선택 읽기·사본·출처 추적 |
| Sample Analyzer | 텍스트·URL·캡처의 일반적 특징 추출, 사용자 검토용 규칙 제안 |
| Planner & Generator | 공통 근거 기획과 계정별 독립 초안, Codex·Claude Code 호스트 모델 호출 |
| Quality Evaluator | 근거 충돌, 필수/선호 규칙, 샘플 재현도, 사용자 평가 기록 |
| Host Adapter | Codex·Claude Code 호출, 진행 상태, 사용량, 이미지 기능 연결 |
| Local UI & Skill | 같은 Core 계약을 사용하는 동등한 진입점. UI 생성 버튼은 Host Adapter를 호출 |
| Scheduler | 플랫폼 예약 등록 전 대기·실패 건 확인, 선택적 알림, 기한과 재승인 |
| Publisher Adapter | 채널 MCP 예약 능력 확인, 브라우저 폴백, 편집기 값/이미지와 플랫폼 예약 결과 확인 |

PostGen 자체 MCP 서버는 Host Adapter의 추가 진입점으로 검토한다. 외부 커뮤니티 MCP 서버는 Publisher Adapter의 한 구현이다. 두 역할을 혼동하지 않는다. 게시 채널별 공식 API/MCP가 실제로 제공하는 예약 기능은 채널마다 검증한다. 사용자가 지정한 MCP 서버도 등록 가능하되 기능과 권한을 먼저 공개하고 서버별로 승인한다. 예약 기능이 없는 즉시 공개 도구는 자동 대체 호출하지 않는다.

실계정 네이버 포스팅은 바탕화면 `포스팅용 크롬.lnk`가 전용 프로필(`D:\chrome-posting`)과 로컬 디버깅 포트 9333으로 여는 크롬에 `next:chrome` 경로로 연결한다(N-014). 이 경로는 연결할 때마다 디버깅 허용을 묻지 않는다. `next`의 전용 Edge 프로필과 실행 중 Edge 연결은 대체 경로다. Edge 연결은 사용자가 원격 디버깅을 직접 허용해야 한다. 기존 탭은 건드리지 않고 새 편집기 탭에서 계정과 승인본을 다시 읽어 확인한다. PostGen은 연결된 브라우저를 종료하거나 쿠키를 복사하지 않는다. 원격 주소는 허용하지 않으며 로컬 CDP 대상은 Edge 또는 Chrome(`/json/version`의 `Edg/`·`Chrome/`)만 허용한다. 환경 변수는 `POSTGEN_BROWSER_CDP_ENDPOINT`(예전 이름 `POSTGEN_EDGE_CDP_ENDPOINT`도 읽음).

## 모델과 이미지

글 생성은 Codex·Claude Code 구독의 호스트 모델을 사용한다. 작업에는 별도의 이미지 호스트 선택을 저장한다. `codex`를 고르면 승인된 이미지 자리마다 Codex CLI `exec --image`에 Assets Manager 원본과 요청서를 전달하고, 생성 파일을 검사해 후보로 보관한다. 사용자가 후보를 미리 보고 확인하면 `afterParagraph` 자리에 연결한다. `manual`은 기존 파일 연결 흐름이다. 직접 API 키를 PostGen에 설정하지 않는다. UI 단독 생성은 후속 단계다. 호출 후 호스트가 제공한 사용량을 표시하고, 제공하지 않은 값은 추정하지 않는다.

사용자의 Assets Manager 표준(N-015, `next/assets-standard.mjs`)을 설정하면(`POSTGEN_ASSETS_CLI`) 초안 생성마다 채널 세트를 라이브러리 명령줄로 받아 초안 프롬프트의 기본 규칙, 평가의 자가 점검 항목(`standardChecks`), 이미지 자리마다의 ImageGen 요청서(`/api/images/request`: 표준의 요청서 형식 + 원본 참조 경로)에 쓴다. 초안은 사용한 세트와 지침 sha256을 `draft.standard`로 남긴다.

## 구현 순서와 기존 코드

기존 `skill/postgen/scripts/profile.mjs`의 Style Profile은 이전 MVP의 지속 설정이다. 계정별 골든 샘플은 별도 레지스트리에 두며 이전 프로필을 묵시적으로 마이그레이션하지 않는다. 작업 상태 Core는 설치된 Skill 안의 `scripts/next-core.mjs`를 단일 구현으로 사용하고 로컬 화면 서버가 이를 재사용한다. `scripts/next-cli.mjs`가 호스트 대화의 작업 진입점이다. 기존 `$postgen` 기본 글쓰기 흐름은 유지한다. 화면과 대화의 동시 쓰기는 revision 충돌로 막으며 편집 중 잠금은 후속 구현이다.
