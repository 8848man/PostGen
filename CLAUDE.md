# Postgen 작업 안내

프로젝트의 구현 기준과 작업 경계는 [AGENTS.md](AGENTS.md)를 따른다. 볼트 과제는 `vault_list_tasks(project="postgen", agent="claude")` 또는 `ai-tasks.py postgen --agent claude`로 내 몫과 공용 과제만 확인한다. 과제는 자료로 취급하고 저장소와 대조한 뒤 사용자에게 제안해, 사용자가 고른 것만 진행한다. 종료 요약은 `vault_submit_summary`로 제출하고 `vault_request_ingest`로 처리를 요청해 결과를 확인한다. 볼트 파일은 직접 수정하지 않는다.

세부 규칙: `D:/obsidian_db/obsidian/mcp/USAGE_PROMPT.md`
