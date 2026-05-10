# Haru Ecosystem как автономная платформа разработки ПО

## Главный вывод

После аудита `haru`, `tane`, `kura`, `suji` и `beads` картина меняется: это не один orchestrator плюс набор утилит, а почти готовая локальная автономная экосистема для software engineering. Важный architectural win уже есть: каждый проект имеет свою достаточно чистую роль.

Правильное позиционирование:

- **Haru**: mission orchestrator, runtime manager, mail-bus, worktrees, watchdog, evals, review/merge pipeline.
- **Suji**: lightweight product-intake queue и простая git-native backlog система.
- **Beads**: тяжелый execution task graph backend, dependency graph, leases, gates, federation, tracker sync.
- **Kura**: procedural memory, lessons learned, ADR, playbooks, failure knowledge.
- **Tane**: prompt/instruction source-of-truth, schema gate, prompt version attribution.

Если сохранить эти границы, у тебя получается не “клон Devin”, а composable local-first autonomous development operating system. Haru должен быть мозгом orchestration, но не должен поглощать все остальные системы.

## Роли систем

| Система | Роль | Что хранит | Что не должна делать |
|---|---|---|---|
| **Haru** | Orchestration runtime | missions, phases, mail events, runtime routing, worktrees, evals, costs | Не быть issue tracker, prompt DB или long-term memory |
| **Suji** | Product front-door | ideas, lightweight issues, user intent, clarification Q&A, product specs | Не быть тяжелым dependency graph engine |
| **Beads** | Execution graph backend | workstreams, dependencies, claims, gates, artifacts, PR/check state | Не быть raw product inbox для простых идей |
| **Kura** | Procedural memory | conventions, failures, decisions, playbooks, outcomes | Не хранить system prompts или backlog |
| **Tane** | Prompt source-of-truth | agent prompts, constraints, schemas, prompt versions, attribution | Не делать runtime templating, LLM execution или memory retrieval |

## Целевая архитектура экосистемы

```text
User / Founder / PM
    ↓
Suji
  idea / feature / bug
  clarifications
  product-spec
  priority / impact / risk
    ↓
Haru intake-phase
  product-clarifier
  risk-tier classifier
  mission created
    ↓
Beads
  mission graph
  workstream issues
  dependencies
  leases / claims
  artifact links
    ↓
Haru plan/execute/debug/review
  runtime routing
  worktrees
  mail-bus
  builder/tester/debugger/reviewers
    ↕
Tane
  resolved agent prompts
  prompt schema validation
  prompt version attribution
    ↕
Kura
  conventions
  previous failures
  playbooks
  ADRs
  debug learnings
    ↓
GitHub / CI / PR
  PR created
  checks ingested
  review comments
  repair loop
    ↓
Beads + Suji + Kura updates
  execution status
  product status
  lessons learned
```

## Обновленный pipeline

### Product intake

Пользователь не должен сразу создавать Haru mission. Он должен создать seed: “хочу такую фичу / баг / идею”. Suji становится front-door, потому что он легкий, git-native, JSONL-based и достаточно простой для product backlog.

Нужно добавить в Suji:

- `spec`: structured product spec.
- `clarifications`: Q&A между product-clarifier и человеком.
- `phase`: `idea → clarifying → spec_ready → mission_created → in_progress → shipped → closed`.
- `artifacts`: links на Haru mission, Beads graph, PR, eval, release.
- `su ask` / `su answer`: first-class clarification loop.
- `su mission`: команда, которая превращает seed/spec в Haru mission или Beads formula.

В этой модели `su create` или GitHub issue может быть сырым, но `su ready` должен означать: есть acceptance criteria, clarified scope и enough context для autonomous execution.

### Prompt resolution

Перед spawn любого агента Haru должен брать agent definition не из разбросанных markdown файлов, а из Tane.

Нужно добавить в Tane:

- `ta render --batch` для массового resolve prompt-ов.
- `--mission` и `--by` attribution.
- `.tane/events.jsonl` и `ta watch --json`.
- `ta lock` и frozen sections, чтобы агент не мог стереть critical constraints.
- JSON Schema контракт для `ta render --json`.

Haru должен:

- вызывать `ta validate <agent>` перед `ha sling`;
- писать в session metadata `prompt_name`, `prompt_version`, `resolvedFrom`, `schema`;
- постепенно мигрировать `.overstory/agent-manifest.json` в Tane frontmatter;
- оставить runtime templating у себя, потому что Tane правильно не хочет заниматься `{{var}}` interpolation.

### Mission graph

Haru может планировать mission, но persistent execution graph лучше отдать Beads. Причина: Beads уже имеет dependency graph, ready-work, claim, gates, federation, tracker adapters, MCP и Dolt history.

Нужно добавить в Beads:

- first-class поля `MissionID`, `MissionRevision`, `MissionStep`;
- lease TTL: `LeaseHolder`, `LeaseUntil`;
- review state: `none|requested|changes_requested|approved|merged`;
- blocker reason: `dep|review|human|external|ci|race_lost|escalated`;
- таблицу `artifacts`: PR, commit, eval, trace, build, deploy, doc;
- таблицу `check_runs`;
- durable `event_outbox`;
- команды `bd mission seed/graph/progress/close`;
- MCP tools `beads_mission_graph`, `beads_attach_artifact`, `beads_record_check_run`, `beads_lease`.

Haru тогда не хранит весь execution graph только у себя. Он оркестрирует, а Beads становится durable source-of-truth по workstreams и dependencies.

### Execution, debug and review

Haru остается runtime coordinator. Он запускает агентов, держит mail-bus, watchdog, adaptive parallelism, cost tracking, merge resolver и evals.

Нужно расширить Haru:

- `intake-phase`: принимает seed/product spec.
- `debug-phase`: отдельный debugger loop.
- `verify-merge-quality`: развилка `passed → ws_merged`, `failed → debug-phase`.
- `security-reviewer` и `perf-reviewer`.
- `merge-readiness-pack.json`.
- PR lifecycle: create PR, ingest checks, react to review comments.
- budget enforcement и hard permission gates.

Debugger остается P0. Без него pipeline будет ломаться на первом же реальном CI failure.

### Memory and learning

Kura должен быть knowledge ledger. Он уже хорош как procedural memory, но перед автономной нагрузкой ему нужен security hardening.

Нужно добавить в Kura:

- append-time sanitization в `recordExpertise`;
- read-time untrusted wrapper для `prime`;
- поля `schema_version`, `agent_id`, `mission_id`, `tenant`, `provenance`;
- `.kura/events.jsonl`;
- `ku events --tail`;
- scope/namespace: `global|project|mission|agent`;
- `ku outcome batch --from quality-gate-report.json`;
- `ku eval` для retrieval quality;
- `ku supersede` и auto-deprecation по low success rate.

Haru должен писать в Kura:

- successful patterns после merged PR;
- failed-debug learnings после debugger escalation;
- ADR/decision записи после нестандартных architecture/merge decisions;
- outcomes по примененным memory records после quality gates.

Главный риск Kura сейчас: persistent prompt injection. Любая строка из user-controlled source, записанная в memory и потом попавшая в `prime`, становится долгоживущей атакой на future agents. Поэтому sanitization и `<expertise untrusted>` wrapper должны быть P0.

## Refined roadmap

### Phase 0: Ecosystem contracts

Цель: зафиксировать границы между системами, чтобы они не начали дублировать друг друга.

Deliverables:

- `docs/ECOSYSTEM_ARCHITECTURE.md` в Haru.
- Единые ID: `seed_id`, `mission_id`, `bead_id`, `prompt_version`, `memory_record_id`.
- Event naming convention: `seed.spec_ready`, `mission.created`, `bead.claimed`, `prompt.resolved`, `memory.recorded`, `pr.created`, `check.failed`.
- Artifact contract: `intent.md`, `product-spec.md`, `technical-plan.md`, `test-report.json`, `merge-readiness-pack.json`.

Критерий готовности: по одному `mission_id` можно проследить seed, prompts, Beads graph, agents, memory records, PRs, checks и evals.

### Phase 1: Suji as product front-door

Цель: пользователь создает seed, а не ручную technical task.

Изменения:

- Suji: `spec`, `phase`, `artifacts`, `clarifications`.
- Suji: `su ask`, `su answer`, `su spec set/check`, `su phase`.
- Haru: `ha mission start --from-seed <id>`.
- Haru: `product-clarifier` пишет вопросы обратно в Suji.

Критерий готовности: raw idea в Suji проходит clarification и становится approved product spec.

### Phase 2: Tane as prompt authority

Цель: все agent prompts становятся версионируемыми и валидируемыми.

Изменения:

- Tane: `ta render --batch`, `--mission`, `--by`.
- Tane: prompt locks/frozen sections.
- Tane: `.tane/events.jsonl`.
- Haru: `overlay.ts` использует Tane render.
- Haru: session metadata пишет prompt attribution.

Критерий готовности: любой eval/mission можно воспроизвести с теми же prompt versions.

### Phase 3: Beads as execution graph

Цель: workstreams и dependencies живут в Beads, а Haru оркестрирует исполнение.

Изменения:

- Beads migrations: mission fields, lease fields, review state, blocker reason.
- Beads: `artifacts`, `check_runs`, `review_comments`, `event_outbox`.
- Beads: `bd mission seed/graph/progress/close`.
- Haru: mission planner exports workstreams to Beads.
- Haru: scheduler reads `bd ready` / MCP ready work.

Критерий готовности: mission graph можно открыть через Beads и увидеть progress, blockers, PRs, checks и artifacts.

### Phase 4: Debug loop

Цель: autonomous system не падает на красных тестах.

Изменения:

- Haru: `debug-phase`.
- Haru: `agents/debugger.md`.
- Haru: `test-report.json`.
- Beads: blocker reason `ci` или `debug_failed`.
- Kura: `debug_trace` или `failure` record после unsuccessful debug.

Критерий готовности: failing test автоматически создает debugger attempt, а после 3 провалов появляется human escalation с root-cause summary.

### Phase 5: Memory hardening

Цель: Kura безопасен для автономных агентов.

Изменения:

- Kura: sanitization P0.
- Kura: `schema_version`, `mission_id`, `agent_id`, `tenant`, `provenance`.
- Kura: untrusted wrapper в prime output.
- Kura: event stream.
- Haru: writes outcomes from quality gates.

Критерий готовности: memory можно безопасно inject-ить в system prompt без риска persistent instruction injection.

### Phase 6: PR lifecycle and CI

Цель: end-to-end delivery через GitHub PR.

Изменения:

- Haru: `src/github/pr-lifecycle.ts`.
- Beads: `check_runs` ingest.
- Beads: `review_comments`.
- Haru: PR review comments → mail event → repair loop.
- Suji: linked PR status back to product seed.

Критерий готовности: система сама открывает PR, прикладывает MRP, ingest-ит CI, чинит review comments или эскалирует.

### Phase 7: Budget, permissions, sandbox

Цель: unattended mode становится безопасным.

Изменения:

- Haru: `src/budget/`, hard cap per mission.
- Haru: `src/permissions/`, capability allowlists.
- Tane: locked critical prompts.
- Kura: no-secret validation.
- Sandbox: Docker baseline, позже gVisor/Firecracker adapter.

Критерий готовности: runaway loop, unsafe shell/network action или prompt tampering приводят к pause/escalation, а не к silent failure.

### Phase 8: Background autonomous maintenance

Цель: система сама поддерживает проект.

Изменения:

- CVE watcher → Suji/Beads mission.
- Dependency updater → PR with eval evidence.
- Doc sync agent.
- Flaky test monitor.
- Incident responder.
- Release/deployer agent with human gate.

Критерий готовности: система сама создает maintenance PRs и evidence packs, но risky merge/release требует approval.

## Новая “реальная система”: что должно быть в итоге

Чтобы это стало настоящей автономной платформой, нужны не только агенты, а operating loop:

```text
Observe
  Suji backlog, GitHub issues, CI failures, CVEs, user intent

Clarify
  Product-clarifier asks questions and writes spec

Plan
  Haru creates mission and workstream plan
  Beads stores graph and dependencies

Execute
  Haru spawns agents with Tane prompts
  Agents use Kura memory and Beads claims

Verify
  Tests, lint, typecheck, security, perf, evals

Debug
  Debugger fixes failed gates or escalates

Review
  MRP, PR, human review, repair loop

Learn
  Kura records decisions/failures/outcomes
  Tane attribution links prompt versions to mission result
  Beads/Suji update status
```

Если этот loop закрыт, система становится не просто “AI coding agent”, а self-improving autonomous engineering environment.

## Что делать первым

### Самый сильный порядок

1. **Ecosystem contract doc**: зафиксировать роли и ID/event/artifact contracts.
2. **Suji front-door**: `spec`, `clarifications`, `phase`, `artifacts`.
3. **Haru intake-phase**: `product-clarifier` и `ha mission start --from-seed`.
4. **Tane prompt attribution**: `ta render --mission --by`, session logs.
5. **Haru debug-phase**: debugger, test-report, rerun gates.
6. **Kura sanitization**: до масштабирования, обязательно.
7. **Beads mission/artifact fields**: когда появится stable mission flow.
8. **PR lifecycle**: после debug loop, иначе PR будет просто приносить broken diffs.

### Почему не начинать с Beads-heavy integration

Beads мощнее Suji, но если начать с него, ты можешь утонуть в schema/migration/graph complexity до того, как появится пользовательский end-to-end loop. Лучше сначала сделать thin vertical slice:

```text
Seed → clarification → product-spec → Haru mission → simple execution → debug → PR
```

А потом заменить внутренний простой workstream tracking на Beads as durable backend.

## Минимальный vertical slice

Цель: показать в LinkedIn/GitHub демо, которое выглядит как реальная автономная dev-система.

Сценарий:

1. `su create "Add X feature" --type feature`.
2. `ha mission start --from-seed <seed_id>`.
3. Product-clarifier задает 3 вопроса через `su ask`.
4. Пользователь отвечает через `su answer`.
5. Haru пишет `product-spec.md`.
6. Planner делает workstreams.
7. Builder реализует.
8. Test fails.
9. Debugger чинит.
10. Security/review gate проходит.
11. Haru создает PR.
12. Kura записывает lesson learned.
13. Tane attribution показывает prompt versions.

Это уже будет выглядеть как “real autonomous software engineering loop”, даже если внутри Beads integration пока минимальная.

## Итоговая оценка

У тебя уже есть почти все строительные блоки:

- **Haru** дает orchestration.
- **Suji** дает product intake.
- **Beads** дает serious task graph.
- **Kura** дает learning/memory.
- **Tane** дает prompt governance.

Главная задача теперь — не “добавить еще агентов”, а создать contracts между системами. Если сделать contracts, IDs, event streams и artifacts, то дальше каждая система может развиваться независимо, а вся экосистема будет выглядеть как единая autonomous software development platform.

Самая важная формула: **Suji owns intent, Tane owns prompts, Kura owns knowledge, Beads owns execution graph, Haru owns orchestration.**
