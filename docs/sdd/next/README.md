# PostGen Next SDD

이 폴더는 그릴링에서 확정한 **목표 제품**의 단일 원본이다. `docs/sdd/00`~`15`는 기존 MVP의 구현·검증 기록이며, 여기 적힌 기능이 이미 구현됐다는 뜻은 아니다.

| 문서 | 단일 원본 책임 |
| --- | --- |
| [01-product-brief](01-product-brief.md) | 문제, 목표, 성공 기준, 제품 경계 |
| [02-delivery-scope](02-delivery-scope.md) | 단계, 포함 범위, 미결정 사항, 현재 구현 상태 |
| [03-workflows](03-workflows.md) | 사용자 흐름과 실패·재개 동작 |
| [04-contracts](04-contracts.md) | 데이터, 버전, 보관, 권한 계약 |
| [05-architecture](05-architecture.md) | 컴포넌트, 호스트·모델·채널 연결 |
| [06-verification](06-verification.md) | 수용 기준과 품질 측정 |
| [07-decisions](07-decisions.md) | 승인된 결정과 기존 ADR의 변경 관계 |

변경 순서: 제품 판단은 01·02·07에서 먼저 수정하고, 영향받는 흐름·계약·아키텍처·검증 문서를 맞춘다. 현재 코드가 지원하는 범위를 02와 README에 별도 표시한다. 실제 계정·외부 MCP·모델 API의 능력과 비용은 구현 전에 검증한다.
