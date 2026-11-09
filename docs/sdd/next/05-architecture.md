# Architecture

## 목표 구성

`선택 Source Provider → SourceBundle → EvidencePlan → 계정별 생성 → 품질 점검 → 계정별 최종본·시각 승인 → MCP/Browser 예약 등록 → 플랫폼 공개 → 결과 확인`

| 계층 | 책임 |
| --- | --- |
| Local Core | 계정·샘플·자산·출처·초안·승인·예약의 버전형 저장과 잠금, 보관 정책 |
| Source Provider | AI 기록, 텍스트/파일, URL, 연결 문서의 선택 읽기·사본·출처 추적 |
| Sample Analyzer | 텍스트·URL·캡처의 일반적 특징 추출, 사용자 검토용 규칙 제안 |
| Planner & Generator | 공통 근거 기획과 계정별 독립 초안, 호스트 모델 또는 공통 모델 호출 |
| Quality Evaluator | 근거 충돌, 필수/선호 규칙, 샘플 재현도, 사용자 평가 기록 |
| Host Adapter | Codex·Claude Code 호출, 진행 상태, 사용량, 이미지 기능 연결 |
| Local UI & Skill | 같은 Core 계약을 사용하는 동등한 진입점. UI 생성 버튼은 Host Adapter를 호출 |
| Scheduler | 플랫폼 예약 등록 전 대기·실패 건 확인, 선택적 알림, 기한과 재승인 |
| Publisher Adapter | 채널 MCP 예약 능력 확인, 브라우저 폴백, 편집기 값/이미지와 플랫폼 예약 결과 확인 |

PostGen 자체 MCP 서버는 Host Adapter의 추가 진입점으로 검토한다. 외부 커뮤니티 MCP 서버는 Publisher Adapter의 한 구현이다. 두 역할을 혼동하지 않는다. 게시 채널별 공식 API/MCP가 실제로 제공하는 예약 기능은 채널마다 검증한다. 사용자가 지정한 MCP 서버도 등록 가능하되 기능과 권한을 먼저 공개하고 서버별로 승인한다. 예약 기능이 없는 즉시 공개 도구는 자동 대체 호출하지 않는다.

## 모델과 이미지

기본 생성은 호스트 모델, 선택 경로는 PostGen 직접 호출의 공통 모델이다. 첫 출시 직접 연결 후보는 OpenAI·Anthropic이다. 모델별 자격 증명은 호스트 자격 증명과 별도로 관리한다. 이미지 기능은 호스트를 우선하고 부족하면 별도 이미지 엔진을 사용한다. UI 단독 생성은 후속 단계다. 비용 추정은 모델별 실제 사용량과 검증된 가격 자료를 분리해 계산하며 추정임을 표시한다.

## 구현 순서와 기존 코드

기존 `skill/postgen/scripts/profile.mjs`의 Style Profile은 이전 MVP의 지속 설정이다. 계정별 골든 샘플은 별도 레지스트리에 두며 이전 프로필을 묵시적으로 마이그레이션하지 않는다. 작업 상태 Core는 설치된 Skill 안의 `scripts/next-core.mjs`를 단일 구현으로 사용하고 로컬 화면 서버가 이를 재사용한다. `scripts/next-cli.mjs`가 호스트 대화의 작업 진입점이다. 기존 `$postgen` 기본 글쓰기 흐름은 유지한다. 화면과 대화의 동시 쓰기는 revision 충돌로 막으며 편집 중 잠금은 후속 구현이다.
