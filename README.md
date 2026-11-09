# Postgen

Postgen은 AI 작업 기록을 근거 있는 블로그 초안으로 바꾸는 Skill입니다. **현재 검증된 실행 환경은 Codex CLI**이며 `$postgen`으로 호출합니다. 제품 목표에는 Claude Code·Claude Cowork와 호환 AI에서의 직접 호출도 포함되지만, 현재 설치기와 사용법은 Codex용입니다.

## 시작하기

Node.js 20 이상과 Codex CLI가 필요합니다. 이 저장소를 내려받은 뒤 **한 번만** 다음 명령을 실행하세요. Skill만 쓸 때는 npm 패키지 설치가 필요하지 않습니다. 로컬 제작·예약 화면은 [아래](#로컬-제작예약-화면)처럼 별도 설치가 필요합니다.

```powershell
node install.mjs
```

이제 글을 만들 프로젝트 폴더에서 Codex CLI를 열고 요청하면 됩니다.

```text
$postgen으로 이 프로젝트 작업 기록을 블로그 글로 만들어줘
```

기본 흐름에서는 기록·프리셋·주제를 고르지 않습니다. 초안은 대화에 먼저 표시되고 파일은 요청할 때만 저장됩니다.

## 필요할 때만

- **스타일 설정:** `$postgen 글쓰기 설정 화면 열어줘`
- **별도 로그 추가:** `$postgen으로 글을 써줘. 로그 파일은 logs/build.txt야.` 저장되지 않은 터미널 출력은 자동으로 복원할 수 없습니다.
- **파일로 저장:** 초안을 본 뒤 `이 글을 Markdown으로 저장해줘` 또는 `HTML로 저장해줘`라고 요청하세요.

자동 탐색은 현재 작업 폴더에 연결된 Codex·Claude Code 완료 대화를 대상으로 합니다. Git 커밋은 현재 폴더가 저장소 루트일 때 보조 근거 후보가 됩니다. 출처 선별·읽기 한도·근거 대조는 Skill 내부 절차입니다.

설치와 호출이 보이지 않으면 Codex를 다시 열어 보세요. 설치기는 새 사용자에게 `~/.agents/skills/postgen`을 사용하고, 기존 `~/.codex/skills/postgen` 설치가 있으면 그 위치를 갱신합니다.

## 개발 문서

- [Skill 지침](skill/postgen/SKILL.md) · [제품·설계 진입점](AGENTS.md)
- [검증 상태](docs/sdd/00-environment.md) · [출처 탐색 벤치마크](docs/sdd/14-source-discovery-benchmark.md)
- [다음 제품 방향과 개선 명세](docs/sdd/next/README.md) · [단계별 범위](docs/sdd/next/02-delivery-scope.md)

새 제품의 계정별 골든 샘플 레지스트리는 `npm run accounts -- list`로 확인하고 `npm run accounts -- add-account naver <계정명> <기본목표>`로 계정을 등록할 수 있습니다. 샘플 등록·규칙 승인·대표 샘플 지정 명령은 `node skill/postgen/scripts/account-cli.mjs`의 사용법을 참조하세요. 등록한 채널·계정을 글 요청에 명시하면 기존 Skill이 승인된 텍스트 규칙을 적용합니다. 기존 Skill의 기본 제작 흐름에는 이미지 생성·예약 화면이 연결되지 않았습니다.

## 로컬 제작·예약 화면

계정별 자료 선택·생성·승인·예약 화면은 저장소 루트에서 실행합니다. 브라우저 예약 등록에 `playwright-core`가 쓰이므로, 처음 한 번 npm 패키지를 설치해야 합니다.

```powershell
npm install
npm run next
```

서버는 `127.0.0.1`에만 열리며, 실행할 때 출력되는 토큰 URL로 접속합니다. 네이버·티스토리 예약 등록은 PostGen 전용 Edge 프로필 창에서 직접 로그인한 뒤 사용합니다. 공통 모델 직접 호출은 `OPENAI_API_KEY` 또는 `ANTHROPIC_API_KEY` 환경 변수가 필요합니다. 세부 사항과 미완료 검증은 [Next 실행 안내](next/README.md)를 참조하세요.

화면과 설치된 `$postgen` Skill의 계정별 작업 CLI는 같은 초안 저장소를 공유합니다. 네이버·티스토리 편집기 실계정 검증은 남아 있습니다.
