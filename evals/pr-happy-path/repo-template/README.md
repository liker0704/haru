# pr-happy-path fixture repo

Minimal seed repository for the pr-happy-path eval scenario.

This fixture tests the Stage E pr-phase happy path:
- PR created via mocked `gh pr create`
- CI passes on first check
- Reviewer approves
- PR merged successfully
- merge-readiness-pack.json artifact written

The `bin/gh` mock intercepts all GitHub CLI calls deterministically.
Set `HARU_EVAL_STATE_DIR` and prepend `bin/` to `PATH` before running.
