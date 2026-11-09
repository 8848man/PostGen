# Postgen 계약 요약

## Source Bundle

`collect.mjs --mode discover`는 `source-catalog/v1`의 짧은 후보 목록을, `--mode read --source-id <id>`는 `source-bundle/v1`의 선택된 본문을 출력한다. 자동 후보는 현재 작업 폴더와 일치하는 Codex·Claude Code 완료 대화, 현재 폴더가 Git 루트일 때의 커밋이다. 일반 로그 파일은 `--input`으로 명시할 때만 후보가 된다. 메시지의 `locator.line`과 `locator.messageIndex`로 근거를 표시한다. `truncated`와 `budget_exhausted`가 있으면 읽지 못한 범위를 알린다. 로컬 JSONL 세부 형식은 호스트 버전에 따라 바뀔 수 있다.

## Knowledge Package

생성 중 다음 구조를 내부적으로 유지한다: `schemaVersion=knowledge-package/v1`, `sourceDocuments[]`, `items[]`, `diagnostics[]`. 항목의 종류는 `Fact`, `Decision`, `Evidence`, `Insight`, `Example`, `Asset`; 공통 필드는 `id`, `kind`, `statement`, `origin`, `sourceRefs[]`, `derivedFrom[]`, `status`다. `Fact`와 `Decision`에는 최소 한 개의 원본 근거가 있어야 한다. `Insight`는 `ai_derived`, 가상 `Example`은 `illustrative`라고 표시한다. 상충하는 주장은 `disputed`로 남긴다.

## 설정 우선순위

Skill Policy → 기본 Profile → 사용자 Profile/프리셋 → 이번 글의 Post Override 순서다. 직접 지정한 Profile 속성은 AI가 추론한 레퍼런스 속성보다 우선한다. 스타일 제안 임계값은 Profile의 `suggestionPolicy.threshold`, 기본 3이다. `rejected`와 `deferred`는 같은 속성 제안을 자동 반복하지 않는다.

## 근거 표시

블로그 본문은 독자가 읽기 쉬워야 한다. `근거 확인`에는 주요 사실·결정의 짧은 설명과 `sourceId`, 메시지 위치를 연결한다. 출처 위치가 유실되면 확정 사실로 서술하지 않는다. 장기 산출물·근거 백로그는 후속 기능이다.
