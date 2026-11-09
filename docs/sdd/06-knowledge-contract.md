# Knowledge Data Contract

## 목적과 수명

Knowledge Package는 매체와 무관하게 한 번의 생성 작업에서 추출한 지식을 전달한다. MVP에서는 생성 중 메모리/임시 산출물로 사용하며 자동으로 장기 보관하지 않는다. 후속 산출물·근거 백로그에서 재사용할 수 있도록 안정적인 식별자와 출처 참조를 정의한다.

## JSON 개념 계약 (`knowledge-package/v1`)

| 필드 | 형식·의미 |
| --- | --- |
| `schemaVersion` | 문자열, `knowledge-package/v1` |
| `packageId` | 생성 작업 내 고유 식별자 |
| `workspaceRef` | 정규화된 작업 폴더 식별자. 외부 출력에는 실제 경로를 기본 노출하지 않음 |
| `createdAt` | ISO 8601 시각 |
| `sourceDocuments[]` | `sourceId`, `provider`, `sessionId?`, `capturedAt`, `workspaceRef`, `availability`, `contentHash?` |
| `items[]` | 아래 지식 항목 |
| `diagnostics[]` | 읽기·파싱·누락·충돌·민감 정보 검토 상태 |

`sourceDocuments`에는 대화 본문 전체를 복제하지 않는다. 본문이 필요한 처리 동안에는 접근 제어된 Source Layer가 제공한다. `sourceId`는 외부로 노출 가능한 원본 식별자와 분리할 수 있다.

## 지식 항목

공통 필드는 `id`, `kind`, `statement`, `origin`, `confidence`, `sourceRefs[]`, `derivedFrom[]`, `status`다.

| 종류 | 의미 | 추가 요구 |
| --- | --- | --- |
| `Fact` | 기록에서 검증 가능한 사실 주장 | 직접 증거 또는 명시적 미확인 상태 |
| `Decision` | 사용자가 내리거나 승인한 결정 | 결정 주체·시점·대안/변경 여부 |
| `Evidence` | 주장에 대한 원문 위치나 자료 | 원본 위치·인용 범위·접근 가능 여부 |
| `Insight` | 자료에서 도출한 AI 해석 | 추론 근거, 사실과 구별하는 표시 |
| `Example` | 이해를 돕는 실제 또는 가상 사례 | `actual`/`illustrative` 구분 |
| `Asset` | 관련 이미지·코드·문서 등 | 유형, 위치 참조, 사용 권한/가용성 상태 |

`origin`은 `source`, `user_assertion`, `ai_derived` 중 하나다. `confidence`는 `high`, `medium`, `low`, `unknown`처럼 설명 가능한 범주로 사용하고 근거 없이 수치를 꾸미지 않는다. `status`는 `confirmed`, `disputed`, `needs_review`, `retracted` 중 하나다.

## 출처와 파생 규칙

- `sourceRefs[]`는 `sourceId`, `locator`(턴·메시지·라인 등 제공자가 지원하는 위치), `excerptHash?`를 포함한다. UI에는 불필요한 원문·절대 경로를 노출하지 않는다.
- `provider`는 대화(`codex-jsonl`, `claude-code-jsonl`), 명시 파일(`explicit-file`), Git 커밋(`git-commit`)을 구별한다. 대화 속 주장과 커밋의 실제 변경은 동일한 검증 수준으로 취급하지 않는다. 잘린 발췌는 원본 전체를 확인한 것으로 표시하지 않는다.
- 파생 항목은 `derivedFrom[]`에 선행 항목 ID를 기록한다. 원본 `Evidence` 없이 `Fact`를 확정하지 않는다.
- 원본에서 충돌하는 정보가 나오면 하나를 임의 선택하지 않고 양쪽 출처와 `disputed` 상태를 남긴다.
- 삭제·정정 요청은 원본 기록을 수정하지 않는다. Knowledge Package 항목 상태와 초안을 갱신한다.
- 가상 예시는 `illustrative`로 표시하고 실제 프로젝트 경험인 것처럼 서술하지 않는다.

## 유효성 규칙

모든 ID는 패키지 내에서 유일해야 한다. 참조한 ID와 출처는 존재해야 한다. `ai_derived` Fact 또는 출처 없는 확정 Fact는 검증 오류다. 원본 위치를 다시 찾을 수 없으면 근거 상태를 `needs_review`로 낮춘다. 버전 불일치는 명시적으로 거부하거나 마이그레이션한다.
