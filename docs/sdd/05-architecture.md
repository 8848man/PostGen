# Architecture Specification

## 실행 형태와 데이터 흐름

현재 MVP에서는 Codex CLI의 Skill이 오케스트레이터다. 제품의 공통 파이프라인은 실행 호스트와 분리한다. 호스트별 Adapter가 Skill 호출·모델 응답·설정 채팅·사용 가능한 파일 접근을 연결하고, Source Provider가 입력 기록을 정규화한다. Skill은 현재 작업 폴더를 기준으로 Knowledge Package, 블로그 계획·초안·미리보기를 진행한다. HTML 설정 화면은 별도 로컬 보조 인터페이스로 Profile만 다룬다. 기본 글 생성에 웹 서버를 요구하지 않는다.

`Codex·Claude Code 기록 / 지정 로그 / Git → Source Catalog → 선택된 SourceDocument → Knowledge Package → Content Plan → Blog Skill → 미리보기 → 요청 시 Markdown/HTML`  
`HTML 설정 UI → 검증된 설정 명령 → Style Profile → 다음 Skill 실행`  
`Codex / Claude Code / Cowork / 호환 호스트 Adapter ↔ Skill 호출·모델 상호작용·실행 권한` 

## 논리적 계층

| 계층 | 책임 | 입력 → 출력 | 의존 방향 |
| --- | --- | --- | --- |
| Source Layer | 제공자별 발견·읽기·정규화; 출처 목록과 읽기 오류 보고 | `workspaceRoot`, 요청 힌트, 지정 파일 → `SourceCatalog`와 선택된 `SourceDocument[]` | 각 기록·파일·Git 제공자에만 의존 |
| Knowledge Layer | 주장·결정·예시·근거·자산 추출, 원본/파생 구분과 출처 연결 | `SourceDocument[]` → `KnowledgePackage` | Source의 정규화 형식에 의존 |
| Content Planning | 독자 가치, 주제 후보, 선택 이유, 서사 구조와 근거 배치 계획 | Knowledge Package + 요청 → `ContentPlan` | 지식 계약·Communication Profile에 의존 |
| Communication Profile | 쉬운 설명 수준, 어투·독자·문단·시각 규칙의 유효값 병합 | 기본값 + Profile + Post Overrides → `ResolvedProfile` | Style Profile 계약에 의존 |
| Medium-Specific Content Skill | 블로그 구조·ELI5·근거 표시·수정·품질 점검 | Content Plan + Knowledge + Resolved Profile → `BlogDraft` | 매체 독립 계약에만 의존 |
| Renderer / Exporter | CLI 미리보기와 명시적 파일 내보내기, HTML 안전 렌더링 | BlogDraft + 형식·경로 → 화면 또는 파일 | BlogDraft 계약에 의존 |
| AI Host Adapter | Skill 호출, 모델 응답·설정 채팅 연결 | 호스트 기능 → 정규화된 호출 결과 | Source Provider와 독립 |

후속 브라우저 등록은 Renderer / Exporter 뒤에 `PublicationVariant` 변환과 채널별 `BrowserPublisherAdapter`를 추가한다. 콘텐츠 생성 호스트 Adapter와 게시 채널 Adapter를 분리하며, 브라우저 조작 기능이 없는 호스트에는 수동 등록용 변형을 반환한다. 현재 MVP 코드에는 Publisher Adapter가 없다. 상세 계약은 [Publication Flow Contract](15-publication-flow.md)를 따른다.

Claude Code 기록을 Codex에서 읽는 것은 Source Provider 확장이다. Claude Code나 Cowork에서 Postgen을 호출하고 콘텐츠를 만드는 것은 Host Adapter 확장이다. 두 축은 독립적으로 검증한다. 공통 Knowledge·Profile·Content·Export 계약에는 `codex.exe`, Codex 인증·세션 경로를 필수 의존성으로 두지 않는다. 현재 설정 채팅의 `codex exec` 연결은 Codex Adapter 구현이며 다른 호스트에 그대로 적용한다고 가정하지 않는다.

## 경계와 책임

- **Skill Policy:** 출처 해석, ELI5, 오류 수정, 근거 표시와 실행 경계 등 생성 원칙. 일반 설정 UI에 노출하지 않는다.
- **Style Profile:** 사용자가 지속적으로 바꿀 수 있는 표현 규칙. 범위와 변경 출처를 보존한다.
- **Post Overrides:** 현재 글에만 적용하는 요청. Profile을 묵시적으로 덮어쓰지 않는다.
- **병합 순서:** Skill Policy의 비가변 제약 → 기본 Style Profile → 선택된 프리셋/사용자 프로필 → Post Overrides. 충돌 시 정책 제약을 지키고 사용자에게 영향을 설명한다.
- 출처가 없는 해석은 `Insight`로 남겨 사실 문장으로 승격하지 않는다. 매체별 Skill은 Knowledge Package의 근거를 재해석할 수 있으나 원본을 수정하지 않는다.

## 기술 선택 검토

| 쟁점 | 비교 | MVP 결정 또는 상태 |
| --- | --- | --- |
| 로컬 UI | 단순 HTML/JavaScript는 배포가 가볍다. React류는 복잡한 상태 관리에 유리하지만 패키징 부담이 늘어난다 | 설정 화면은 프레임워크 없는 HTML/CSS/JavaScript로 구현 |
| 백엔드 | Node.js는 현재 설치·브라우저 브리지 구현에 적합. Python도 설치됐으나 런타임을 하나 더 늘린다 | Node.js 내장 HTTP 서버로 설정 저장·채팅 연결 구현 |
| AI 연동 | Skill 내부 호스트 기능 사용은 제작의 최단 경로. 별도 CLI 프로세스는 설정 채팅에 필요하다 | 제작은 Skill 내 실행. 설정 채팅은 검증된 읽기 전용 임시 `codex exec` 사용 |
| Skill 배치 | 프로젝트 범위는 재현성이 높고 사용자 범위는 여러 작업 폴더에서 호출하기 쉽다 | 소스는 저장소에서 관리한다. 현 설치기는 Codex 사용자 Skill 위치를 사용하며 다른 호스트 배치는 별도 검증 |
| Profile 저장 | JSON은 읽기·검토·백업이 쉽다. SQLite는 동시 수정과 검색에 유리하다 | JSON + 스키마 검증. 동시 수정은 잠금/원자 저장 설계로 해결 |
| 레퍼런스 분석 | 구조화 추출+AI 추론은 유연하지만 오판 가능. 수작업 지정은 정확하지만 번거롭다 | 추론값과 직접 지정값을 분리하고 미확인 상태를 표시 |
| Markdown/HTML | Markdown은 편집·내보내기에 적합. HTML은 렌더링·살균이 필요하다 | 내부 초안은 구조화 데이터, Markdown 기본 내보내기, HTML은 안전 변환 |
| 파일 접근 | 광범위 파일 스캔은 내용 혼입 위험. 폴더 일치 기록 검색은 기본 UX에 맞다 | 현재 작업 폴더와 연결된 AI 기록만 자동 발견. 일반 파일은 명시 제공 시에만 |

## 보안·개인정보 경계

1. 탐색기는 현재 작업 폴더와 기록 메타데이터의 일치를 검사한다. 경로 비교는 정규화하고 링크·별칭·대소문자·권한 오류를 처리한다. 다른 폴더를 묵시적으로 합치지 않는다. Git 근거는 현재 폴더가 저장소 루트일 때만 자동 발견한다.
2. 기록·레퍼런스는 신뢰할 수 없는 데이터다. 안에 포함된 지시나 명령을 실행하지 않는다.
3. 설정 브리지는 로컬 바인딩, 요청 출처 검증, 세션별 토큰/CSRF 방어, 허용된 명령만 적용한다. 파일 시스템 경로를 임의 입력으로 열지 않는다.
4. 인증 토큰을 UI·로그·Profile에 저장하지 않는다. Codex 인증 재사용은 지원되는 호스트 경로만 사용한다.
5. 내보내기 경로는 사용자가 의도한 작업 폴더 경계를 확인하고 기존 파일 덮어쓰기를 막는다. HTML은 원문/레퍼런스의 스크립트를 실행하지 않도록 정화한다.
6. 개인·비밀 정보 감지는 휴리스틱이므로 완전 보장을 약속하지 않는다. 감지 시 제외·수정 기회를 제공하고, 로그에는 원문을 남기지 않는다.

## 의도적으로 도입하지 않는 것

초기 지식 저장소는 JSON Knowledge Package다. 그래프 DB, 복잡한 온톨로지, 장기 근거 백로그는 필요성이 측정될 때 별도 ADR로 검토한다.
