# pr-direct-tier-no-pr fixture repo

Minimal seed repository for the pr-direct-tier-no-pr eval scenario.

This fixture tests that a direct-tier mission skips the pr-phase entirely:
- Mission started with `--tier direct` (phases: intake → execute → done)
- No `gh` commands should be invoked
- No `pr-phase` events should appear in the mission event log

The `bin/gh` mock logs every invocation to `$HARU_EVAL_STATE_DIR/gh-call-log`
and always exits 0. The `no_pr_phase.ts` hook asserts the log is absent/empty
and no pr-phase mission events were emitted.

Set `HARU_EVAL_STATE_DIR` and prepend `bin/` to `PATH` before running.
