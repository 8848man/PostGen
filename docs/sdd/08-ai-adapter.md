# AI Adapter Contract

## 목적

제품의 제작 호스트는 교체 가능해야 한다. 현재 구현 호스트는 Codex Skill이며, Claude Code·Cowork와 호환 가능한 다른 AI 호스트는 후속 Adapter 대상이다. 입력 출처는 실행 호스트와 독립이다. Codex·Claude Code 로컬 기록, 사용자가 지정한 텍스트 로그, Git 커밋을 같은 SourceDocument로 정규화한다. 다른 AI 기록을 읽으려면 별도 Source Provider를 추가한다.

## 포트와 결과

| 포트 | 요청 | 결과·오류 |
| --- | --- | --- |
| `discoverSources` | 정규화된 작업 폴더, 요청 힌트, 범위 정책 | `source-catalog/v1` 후보 메타데이터와 진단 |
| `readSource` | 허용된 source ID, 문자 예산, 명시 파일 경로 | `source-bundle/v1` 메시지·원본 위치·잘림 상태 |
| `generateStructured` | 작업 유형, 입력 계약, 결과 스키마 | 스키마에 맞는 결과 또는 명시적 실패 |
| `continueInteraction` | 설정 채팅의 승인된 문맥·요청 | 표시용 답변 및 `SettingCommand` 후보 |
| `capabilities` | 없음 | 기록 접근·구조화 출력·스트리밍·설정 채팅 지원 여부 |

공통 오류 분류: `not_authenticated`, `permission_denied`, `source_unavailable`, `unsupported_version`, `invalid_output`, `rate_limited`, `cancelled`, `internal_error`. 오류는 토큰, 대화 원문, 민감한 절대 경로를 로그에 포함하지 않는다.

## Source Provider 계약

새 AI 입력 제공자는 `discover(workspace, query)`에서 안정적 `sourceId`, `provider`, `capturedAt`, 짧은 `preview`와 원문을 읽을 수 있는지의 상태를 반환하고, `read(sourceId, budget)`에서 `role`, `content`, `locator.line`을 지닌 메시지를 반환한다. 기록을 자동 탐색할 수 없는 제공자는 `unsupported`를 명시하고 사용자 지정 파일 수입을 사용한다. 제공자 구현은 인증 정보나 다른 제공자의 기록을 요구하지 않는다. `sourceId`는 제공자와 원본 ID를 함께 해시해 충돌을 피한다.

후보 선정은 프로젝트 경계를 먼저 적용하고 요청 관련성을 평가한 뒤 날짜순으로 정렬한다. 관련성 점수는 현재 어휘 일치 기반의 초기값이며, 서로 다른 도구에서 이어진 하나의 작업을 항상 자동 연결한다고 보장하지 않는다. 원문을 모두 모델로 보내지 않고 선택 출처만 읽으며, 잘린 발췌는 `excerpt`와 진단으로 표시한다. 지속 요약 캐시는 원문 변화·출처 정정 처리 정책이 정해진 뒤 도입한다.

## Codex MVP 매핑

- 글 제작의 모델 상호작용은 호출된 Codex Skill 내부에서 수행한다. Skill이 자기 자신을 중첩 CLI 프로세스로 부르는 것을 기본 경로로 삼지 않는다.
- Codex와 Claude Code 로컬 JSONL 파서는 각각 출처 제공자에 격리한다. 관찰한 `cwd`와 메시지 형식은 공개 불변 계약으로 간주하지 않는다. 일반 CLI 출력은 명시적으로 저장·제공된 텍스트 파일만 읽을 수 있다.
- Codex의 내부 승인 심사 세션처럼 호스트가 생성한 관리 기록은 사용자 작업과 구별한다. 현재 관찰된 `session_meta.source.subagent.other=guardian`은 후보에서 제외한다. 이 메타데이터도 버전 변화 대상이므로 회귀 테스트를 유지한다.
- 출처 목록은 짧은 미리보기만 모델에 전달한다. 요청과 프로젝트 관련성을 본 뒤 `sourceId`로 필요한 본문만 읽는다. 읽기 기본 한도는 36,000자, 최대 120,000자이며 문자 수는 토큰 수의 정확한 대용이 아니다. 잘림과 예산 소진을 진단으로 반환한다.
- Git 커밋은 현재 작업 폴더가 저장소 루트일 때 보조 근거로 발견한다. 대화 주장을 커밋만으로 자동 확정하지 않는다.
- 설정 HTML의 채팅은 별도 로컬 Node 브리지에서 `codex exec --ephemeral --sandbox read-only --output-schema`를 호출한다. 기존 Codex CLI 로그인으로 구조화 응답과 실제 설정 적용을 검증했다. 프로필 변경은 검증된 `SettingCommand`에 한정한다.
- 첫 중첩 비대화형 호출은 제한된 조사 샌드박스에서 상태 DB 접근 오류로 실패했지만, 승인된 실행 환경에서 성공했다. 환경 제약과 제품 오류를 구분한다.

## 다른 AI 확장

향후 호스트 구현은 동일한 SourceDocument·Knowledge Package·Style Profile·BlogDraft 계약을 사용해야 한다. Host Adapter는 Skill 발견·호출, 모델의 구조화 응답, 로컬 파일·셸 접근, 설정 채팅, 내보내기 가능 여부를 `capabilities`로 알린다. 대화 기록 접근이 불가능한 호스트는 자동 발견을 약속하지 않고 사용자가 명시적으로 제공한 입력을 처리한다. 인증 자료를 Adapter 간 공유하거나 Profile에 저장하지 않는다.

**필수 호스트 순서:** Claude Code에서는 `SKILL.md`를 해당 호스트에 설치하고 `/postgen` 호출부터 생성·수정·내보내기까지 검증한다. Claude Cowork는 Skills를 지원하지만 실행 위치와 로컬 파일 접근이 Claude Code와 다르므로 별도의 기술 검증과 입력 브리지가 필요하다. 이후 호환 AI 호스트는 공통 계약 적합성 시험을 통과해야 지원으로 표기한다. `SKILL.md` 형식의 호환성만으로 Postgen 전체 기능의 실행 호환성을 선언하지 않는다.

현재 상태: Codex 실행·설정 채팅은 검증됨. Claude Code 기록 입력은 합성 자료로 검증됐으나 Claude Code에서 Postgen Skill 실행은 미검증. Cowork 실행·설정·로컬 기록 접근은 미검증. 다른 AI 호스트도 미구현·미검증이다.
