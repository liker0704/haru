# pr-ci-failure fixture repo

Minimal seed repository for the pr-ci-failure eval scenario.

This fixture tests the Stage E pr-phase CI failure path:
- PR created via mocked `gh pr create`
- `gh pr checks` returns `failure` on calls 1 and 2 (counter in `$HARU_EVAL_STATE_DIR/check_counter`)
- `gh pr checks` returns `SUCCESS` on call 3+
- Engine dispatches debugger on CI failure
- Mission recovers and merges after CI passes

The `bin/gh` mock tracks call count with a counter file.
Set `HARU_EVAL_STATE_DIR` and prepend `bin/` to `PATH` before running.
