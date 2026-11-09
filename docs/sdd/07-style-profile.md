# Style Profile Schema와 설정 명령

## 레이어

- **Skill Policy**는 생성·근거·레퍼런스 해석 원칙이며 일반 UI에서 편집하지 않는다.
- **Style Profile**은 사용자가 지속적으로 선택한 표현 방식이다.
- **Post Overrides**는 현재 콘텐츠 작업에만 적용한다.

## JSON 개념 계약 (`style-profile/v1`)

| 필드 | 값·규칙 |
| --- | --- |
| `schemaVersion`, `profileId`, `revision`, `updatedAt` | 버전·식별·낙관적 동시 수정 기준 |
| `scope` | `user` 또는 `workspace`; 적용 범위를 명시 |
| `presetId?` | `explain`, `worklog`, `analysis` 중 선택하거나 없음 |
| `writingStyle` | 서술 밀도·용어 설명·예시 사용 원칙 |
| `tone` | 어투와 격식 |
| `paragraph` | 길이 선호와 분리 기준 |
| `audience` | 독자 지식 수준·관심사 |
| `explanationLevel` | 쉬운 설명의 깊이 |
| `structure` | 도입·본문·요약 등 구성 선호 |
| `visualStyle` | UI/이미지 스타일 선호. 자동 이미지 생성 동의와 별개 |
| `visualCriteria` | 표·도식·이미지 제안 기준 |
| `chooseTopicBeforeGeneration` | 불리언, 기본 `false` |
| `fields.<name>.provenance` | `default`, `preset`, `user`, `ai_inferred` 중 하나와 근거 참조 |
| `suggestionPolicy` | 같은 스타일 속성 반복 수정 임계값, 기본 3; 거절/보류 기록 |

직접 지정값은 AI 추론값보다 우선한다. 추론값은 확정 값처럼 표시하지 않고 수락·편집 가능하게 한다. Profile에는 인증 정보, 대화 본문, 원본 레퍼런스 바이너리를 넣지 않는다.

## 기본 프리셋

| ID | 사용자 목적 키워드 | 방향 |
| --- | --- | --- |
| `explain` | `#쉽게이해` `#개념정리` | 초심자, 짧은 문단, 용어 풀이·비유 |
| `worklog` | `#실무기록` `#의사결정` | 작업 과정·선택 이유·결과 중심 |
| `analysis` | `#깊이있는분석` `#근거중심` | 맥락·대안·한계·근거 연결 강조 |

프리셋은 시작점이며 사용자가 속성별로 덮어쓸 수 있다. 적용 전후 차이는 UI에서 미리 볼 수 있어야 한다.

## 설정 명령 계약

HTML 설정 채팅은 AI의 자연어 응답을 직접 파일 편집에 연결하지 않는다. AI가 `SettingCommand`를 제안하고 로컬 검증기가 적용한다.

허용 명령은 `set_field`, `unset_field`, `apply_preset`, `remove_reference`, `set_topic_choice`, `set_suggestion_policy`다. 명령에는 `expectedRevision`, `scope`, `operation`, `path`, `value`, `reason`을 포함한다. 허용된 경로와 타입만 통과하고, 변경 범위와 효과를 화면에 보여준다. 낯선 명령·필드·범위·낡은 revision은 거부한다. 여러 명령은 전부 유효할 때 원자적으로 적용한다.

MVP 구현에서는 레퍼런스 추가를 사용자가 파일 업로드로 직접 시작하며, AI 채팅은 파일 경로를 지정해 추가하지 못한다. 서버가 업로드 유형·크기를 검증하고 Profile에 참조를 등록한다. 설정 명령의 `commandId`는 후속 감사 로그 도입 시 확장할 필드이며 현재 구현은 Profile `revision`과 적용 결과로 변경을 추적한다.

레퍼런스 입력은 파일 경로·미디어 유형·원본 출처만 별도 참조 저장소에 연결한다. 분석 결과는 `ai_inferred` 후보로 Profile에 제시하며 사용자 직접 지정값을 조용히 교체하지 않는다. 원본 HTML·이미지의 활성 콘텐츠는 실행하지 않는다.
