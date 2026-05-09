# Overstory как автономная система разработки ПО

## Короткий вывод

Overstory уже не выглядит как “сырой агентный эксперимент”. По аудиту репозитория это зрелый CLI-фреймворк оркестрации агентов на Bun и TypeScript с graph engine миссий, DAG-фазами, SQLite mail-bus, runtime-адаптерами, watchdog, merge resolver, observability, recovery и eval framework. Самое важное: core переписывать не надо. Реалистичный путь к autonomous software development: добавить вокруг существующего `missions` graph engine несколько недостающих фаз и capabilities.

Главный разрыв сейчас не в оркестрации, а во входе и выходе. На входе не хватает слоя `intent → clarification → product-spec`. На выходе не хватает `debug/test-fix loop`, post-execution reviewers, native PR lifecycle, CI/sandbox gates и hard budget/permission enforcement. Именно поэтому самые высокие ROI-изменения: Stage A `Intake & Spec` и Stage C `Debug Loop`.

## Что Overstory уже умеет

| Компонент | Текущее состояние | Почему это ценно для autonomous dev |
|---|---|---|
| Mission graph engine | `src/missions/engine.ts` исполняет DAG фаз `understand → plan → execute → done` с async/human gates | Новые фазы `intake`, `debug`, `review`, `deploy` можно добавить без редизайна core |
| Runtime abstraction | `src/runtimes/` содержит адаптеры к нескольким CLI-агентам | Можно делать cost/quality routing: clarifier на дешевой модели, builder/architect на frontier |
| Mail-bus | `src/mail/` на SQLite с claim/ack/DLQ/lease | Готовая основа для async HITL, PR comments, debugger events, budget alerts |
| Worktree isolation | `ha sling` создает worktree и branch per task | Это уже совпадает с паттерном параллельной разработки через git worktrees |
| Plan review subgraph | `plan-review` dispatches critics, collects verdicts, loops until convergence | Это почти готовый verification pattern для spec/plan review |
| Merge resolver | Clean merge, auto-resolve, AI-resolve, reimagine | Хорошая основа для autonomous merge, но destructive tiers требуют hard human gate |
| Watchdog | Per-node grace/ceiling, stuck detection, respawn, nudge | Нужен для long-running autonomous missions |
| Observability | Events, metrics, costs, OTLP, LangSmith, LangFuse, dashboard | Уже есть база для production debugging и cost attribution |
| Eval framework | `src/eval/` со scenario-based evaluation | Можно превратить в eval-as-CI и regression gate |

## Сравнение с готовыми решениями

| Решение | Что важно заимствовать для Overstory | Что не стоит копировать напрямую |
|---|---|---|
| Cognition Devin | Interactive Planning, DeepWiki-like repo knowledge, fleet-mode, pre-PR review, playbooks. Devin продвигает модель, где агент сначала исследует codebase и согласует план, а не сразу пишет код ([Cognition Devin 2.0](https://cognition.ai/blog/devin-2)). | Закрытую enterprise-модель и “магический” fully autonomous UX. Overstory лучше строить как прозрачный orchestrator с трассами и gates. |
| OpenHands | Event-sourced state, Action→Execution→Observation контракт, SecurityAnalyzer, ConfirmationPolicy. OpenHands SDK явно делает separation между agent logic, workspace и applications ([OpenHands SDK](https://arxiv.org/html/2511.03690v1)). | Полный переход на их runtime. У Overstory уже есть свой mail-bus, event store и graph engine. |
| Aider | Repo Map через tree-sitter, graph ranking, token-budget-aware context, Architect/Editor split. Aider описывает repo map как AST + graph + ranking, а не как naive vector search ([Aider Repo Map](https://aider.chat/docs/repomap.html)). | Интерактивный pair-programming UX как основной режим. Overstory нужен async mission pipeline. |
| Claude Code | Простая master-loop модель, project memory через `CLAUDE.md`, subagents с ограниченной глубиной, checkpoints и hooks. Anthropic формулирует routing, chaining, parallelization и evaluator-optimizer как базовые agent patterns ([Anthropic](https://www.anthropic.com/research/building-effective-agents)). | Не надо превращать Overstory в один большой Claude Code wrapper. Ценность Overstory именно в orchestration, mail-bus и multi-runtime. |
| GitHub Copilot Coding Agent | GitHub-native PR workflow: issue/task → branch → commits → PR → checks → review steering. GitHub описывает coding agent как cloud agent, который работает в GitHub Actions-like environment и возвращает PR ([GitHub Docs](https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent)). | Auto-merge по умолчанию. Для planned/full tiers merge должен оставаться human-approved. |
| Cursor | Plan Mode, clarifying questions до execution, editable Markdown plan, parallel agents via worktrees. Cursor прямо рекомендует не запускать agent mode blindly и сначала уточнять задачу ([Cursor Agent Best Practices](https://cursor.com/blog/agent-best-practices)). | IDE-first UX. Overstory лучше держать CLI/API-first и позже добавить web UI. |
| SWE-agent | Agent-Computer Interface, replayable trajectories, lint-on-edit guard, Docker/Modal sandbox, test failure as feedback. SWE-agent показывает, что интерфейс инструментов надо проектировать под LM, а не под человека ([SWE-agent paper](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf)). | Оптимизацию только под SWE-bench. Для Overstory важнее production metrics и internal held-out benchmark. |

## Целевая архитектура

```text
Trigger layer
  GitHub issue, Slack, CLI, API, incident webhook
      ↓
Intake phase
  product-clarifier ↔ human
  product-spec.md
  risk-tier classifier
      ↓
Understand phase
  existing scout/research agents
  codebase index: AST + FTS + optional vectors + mulch
      ↓
Plan phase
  existing architect + workstream DAG
  existing plan-review critics
      ↓
Execute phase
  builder/tester per workstream
  verify-merge-quality
      ↓
Debug phase
  debugger reads test-report.json
  root-cause → minimal fix → rerun gates → fixed or escalate
      ↓
Review gates
  security-reviewer, perf-reviewer, architecture-review
  merge-readiness-pack.json
      ↓
PR lifecycle
  gh pr create → checks ingest → review comments → repair loop
  human approval for planned/full
      ↓
Done/deploy
  summary, mulch learnings, optional deployer
```

Ключевой принцип: не делать “одного универсального агента”. Overstory уже имеет правильную форму: orchestrator + specialized capabilities + mail-bus + graph phases. Нужно усилить contract между фазами через артефакты: `intent.md`, `product-spec.md`, `technical-plan.md`, `test-report.json`, `merge-readiness-pack.json`.

## Стадии развития

### Stage A: Intake & Spec

Цель: превратить сырое “я хочу вот такую фичу” в структурированный `product-spec.md`. Это должна быть новая pre-`understand` фаза, а не часть текущего planning. Clarifier должен задавать ограниченное число вопросов, например до 5, затем формировать spec с goal, non-goals, user stories, acceptance criteria, constraints, risk tier и suggested workstreams.

Изменения:

- `src/missions/cells/intake-phase.ts`: новый subgraph `ingest-intent → clarifier-dispatch → await-clarifications → spec-draft → human-spec-review → ready`.
- `agents/product-clarifier.md`: новая роль.
- `src/agents/capabilities.ts`: capability `product-clarifier`.
- `src/commands/mission.ts`: `ha mission start --from-intent "..."` и `--interactive`.
- `.overstory/artifacts/<mission>/product-spec.md`: официальный contract между product layer и technical planning.
- `src/missions/risk-tier.ts`: deterministic classifier для `direct/planned/full`.

Критерий готовности: пользователь может дать одну неструктурированную задачу, агент задает уточняющие вопросы, после подтверждения появляется `product-spec.md`, и только потом начинается `understand/plan`.

### Stage B: Codebase Intelligence

Цель: дать clarifier, planner и debugger фактический ground truth о кодовой базе. На рынке сильный паттерн: AST/graph-based repo map лучше для navigation, а vector search полезнее для docs/comments. Aider строит repo map через tree-sitter и graph ranking ([Aider Repo Map](https://aider.chat/docs/repomap.html)), а Cursor дополняет это semantic indexing по function/class chunks ([Cursor Composer](https://cursor.com/blog/composer)).

Изменения:

- `src/memory/codebase-index.ts`: baseline на SQLite FTS5.
- `src/memory/ast/`: tree-sitter parser и symbol graph.
- `src/memory/retrieve.ts`: API `keyword → file → symbol → snippet`.
- Optional adapter: LanceDB/Qdrant/OpenAI/Voyage embeddings, но не как mandatory dependency.
- Post-merge hook: incremental reindex.
- `OVERSTORY.md`: project-level memory file с conventions, commands, architecture notes, forbidden patterns.

Критерий готовности: planner может получить ranked file map и suggested file scope без полного grep по репозиторию, а debugger может локализовать failing symbol через structural index.

### Stage C: Debug/Test-Fix Loop

Цель: закрыть главный functional gap. Сейчас после `execute-phase` нет специализированного цикла “tests failed → analyze → minimal fix → retest”. Это нельзя оставлять на builder, потому что builder уже biased своим решением, а reviewer ловит проблему слишком поздно.

Изменения:

- `agents/debugger.md`: новая роль.
- `src/agents/capabilities.ts`: capability `debugger`.
- `src/missions/cells/debug-phase.ts`: subgraph `await-test-results → analyze-failures → dispatch-debugger → await-fix → re-run-gates → fixed/stuck`.
- `src/missions/cells/execute-phase.ts`: вставить `verify-merge-quality` перед `ws_merged`.
- `src/missions/handlers.ts`: deterministic handlers `analyze-failures`, `re-run-gates`.
- `.overstory/artifacts/<mission>/<workstream>/test-report.json`: обязательный artifact.
- `evals/debug-loop.scenario.yaml`: regression eval на сломанный тест.

Ограничения debugger-а:

- `max-iterations = 3`.
- Не редактировать тесты, кроме явно `@autogenerated`.
- Работать только в worktree текущего workstream.
- При повторном failure делать `escalate_to_human` с Consultation Request Pack.
- Всегда сохранять root-cause hypothesis и commands/results в artifact.

Критерий готовности: красный test/type/lint gate автоматически приводит к debugger mission, после чего либо появляется fix commit, либо human получает компактный escalation pack.

### Stage D: Post-Execution Review Gates

Цель: добавить review после кода, а не только review плана. Это повторяет практику Devin Review и CI security gates: отдельный reviewer не должен быть тем же агентом, который писал код ([Cognition Performance Review](https://cognition.ai/blog/devin-annual-performance-review-2025), [GitHub Agentic Workflows](https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/)).

Изменения:

- `agents/security-reviewer.md`: SAST, dependency audit, secrets scan, prompt-injection review для LLM-интеграций.
- `agents/perf-reviewer.md`: benchmarks, hot path checks, regression risks.
- `merge-readiness-pack.json`: unified artifact с tests, lint, typecheck, security, perf, reviewer verdicts.
- `execute-phase.ts`: для `planned/full` запускать security/perf gates.

Критерий готовности: PR не создается, пока нет MRP с green/passed или явным waiver.

### Stage E: Native GitHub PR Lifecycle

Цель: сделать Overstory не просто локальным orchestrator, а системой, которая доставляет изменения через нормальный PR loop. GitHub Copilot Coding Agent показывает сильный pattern: async task работает в GitHub-native workflow и возвращает PR для review ([GitHub Docs](https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent)).

Изменения:

- `src/github/pr-lifecycle.ts`: create PR, update PR body, attach MRP, ingest checks.
- `src/tracker/github.ts`: оставить inbound issues, не смешивать с outbound PR lifecycle.
- PR comment polling/webhook: `pr_review_comment` mail event.
- Debugger/builder repair loop на review comments.
- `src/notifications/external.ts`: Slack/Discord/email уведомление “PR ready for review”.
- Policy: `direct` может auto-create PR, `planned/full` требуют human approval before merge.

Критерий готовности: Overstory сам открывает PR, пишет description с evidence, ingest-ит CI checks и реагирует на review comments.

### Stage F: Budget Enforcement & Hard Permission Gates

Цель: сделать unattended mode безопасным. В текущем Overstory есть cost tracking, но нет hard kill-switch. Для autonomous режима это критично, потому что runaway loop быстро превращается в cost amplification.

Изменения:

- `src/budget/policy.ts`: per-mission, per-runtime, per-day budgets.
- `src/budget/enforcer.ts`: hard stop, pause, downgrade model, escalate.
- `src/permissions/policy.ts`: capability-level command/network/file allowlists.
- PreToolUse-style hard enforcement для risky shell/network actions.
- Unknown action = destructive by default.

Критерий готовности: миссия останавливается или переводится в human gate при budget/policy violation, а не просто логирует превышение.

### Stage G: Container/VM Sandbox & CI-as-Gate

Цель: перейти от worktree isolation к execution isolation. Docker удобен как baseline, но для production-grade agent execution sandbox стоит рассматривать gVisor/Firecracker-style изоляцию. Современные sandbox guides для coding agents рекомендуют deny-by-default network, capability dropping, ephemeral lifecycle и filesystem scoping ([Bunnyshell Sandbox Guide](https://www.bunnyshell.com/guides/coding-agent-sandbox/), [Docker Sandboxes](https://www.docker.com/blog/docker-sandboxes-a-new-approach-for-coding-agent-safety/)).

Изменения:

- `ha sling --sandbox=docker`.
- `src/sandbox/`: adapters `local`, `docker`, later `gvisor/firecracker`.
- Network policy: default deny, allow by explicit task policy.
- Eval-as-CI: GitHub Action runs `evals/`, stores baseline, blocks autonomous merge on regression.

Критерий готовности: builder/debugger не выполняют произвольный код на host environment, а CI/eval regression может заблокировать delivery.

### Stage H: Background Autonomous Agents

Цель: перейти от task-based autonomous dev к платформе, которая сама поддерживает проект. Это уже не MVP, а настоящая platform layer.

Изменения:

- CVE/dependency watcher: OSV/Trivy/SCA scan → issue/mission → PR.
- Doc-sync agent: public API diff → docs PR.
- Stale PR reaper.
- Flaky test monitor.
- Incident responder: production alert → reproduction → fix candidate → PR.
- Deployer: staging/canary/prod pipeline, но только после strong approval gates.

Критерий готовности: система сама создает maintenance PRs, но merge/release остается policy-controlled.

## Debugger-agent: нужен ли он

Да, обязателен. Если выбирать один новый агент после product-clarifier, это debugger. Без него Overstory будет хорошо планировать и запускать workstreams, но будет ломаться на самом частом месте autonomous development: тесты красные, typecheck упал, lint упал, CI failure непонятен, acceptance criteria частично не выполнены.

Debugger не должен быть “еще одним builder”. Его работа: диагностировать, ограничить scope, сделать минимальный fix, rerun gates и эскалировать, если confidence низкий. Он должен быть встроен не рядом с `execute-phase`, а прямо в нее через `verify-merge-quality`: `passed → ws_merged`, `failed → debug-phase`.

Минимальный контракт debugger-а:

```text
Input:
  worker_done or worker_failed mail
  test-report.json
  technical-plan.md
  product-spec.md
  current diff

Process:
  classify failure: test/type/lint/runtime/flaky/acceptance
  produce root-cause hypothesis
  edit minimal file scope
  rerun gates
  repeat max 3

Output:
  fix_committed
  or escalate_to_human with Consultation Request Pack
```

Главный риск: infinite loop и cost runaway. Поэтому `max-attempts`, `max_total_wait_ms`, budget cap и no-test-edit policy должны быть в первом же PR debug-loop, а не “потом”.

## Repo-level actions

| Priority | Action | Files/folders |
|---|---|---|
| P0 | Добавить capabilities `product-clarifier`, `debugger`, `security-reviewer`, `deployer` | `src/agents/capabilities.ts`, `agents/*.md` |
| P0 | Добавить `intake-phase` | `src/missions/cells/intake-phase.ts`, `src/missions/engine.ts`, `src/missions/handlers.ts` |
| P0 | Добавить `debug-phase` и `verify-merge-quality` | `src/missions/cells/debug-phase.ts`, `src/missions/cells/execute-phase.ts` |
| P0 | Стандартизировать artifacts | `src/missions/artifact-paths.ts`, `.overstory/artifacts/` |
| P1 | Добавить codebase index | `src/memory/codebase-index.ts`, `src/memory/ast/`, `src/memory/retrieve.ts` |
| P1 | Добавить budget enforcement | `src/budget/policy.ts`, `src/budget/enforcer.ts` |
| P1 | Добавить hard permission policies | `src/permissions/policy.ts`, `.overstory/policies/*.yaml` |
| P1 | Добавить outbound PR lifecycle | `src/github/pr-lifecycle.ts` |
| P1 | Расширить mail types | `src/mail/types.ts` |
| P2 | Добавить external notifications | `src/notifications/external.ts` |
| P2 | Добавить MRP artifact и review gates | `src/review/`, `agents/security-reviewer.md`, `agents/perf-reviewer.md` |
| P2 | Добавить eval baseline/regression diff | `src/eval/baseline.ts`, `src/eval/regression.ts` |
| P2 | Добавить auth для webserver | `src/webserver/auth.ts`, `src/webserver/server.ts` |
| P3 | Добавить sandbox adapters | `src/sandbox/` |
| P3 | Добавить background maintenance agents | `agents/cve-watcher.md`, `agents/doc-sync.md`, `agents/deployer.md` |

## Что не делать

- Не переписывать `missions` на LangGraph. У Overstory уже есть хороший graph engine, mail-bus, watchdog и recovery.
- Не делать vector DB mandatory dependency. Начать с SQLite FTS5 + tree-sitter, vector backend оставить adapter-ом.
- Не запускать code execution сразу после intent. Сначала clarification и spec approval.
- Не делать auto-merge для `planned/full`. AI PRs требуют human review, особенно если меняются API, auth, migrations, billing или security-sensitive code.
- Не начинать с красивого web UI. Сначала pipeline reliability: intake, debug, review gates, PR lifecycle, budget enforcement.
- Не делать unlimited parallel agents. Anthropic и Cursor patterns сходятся в одном: controlled parallelism и scoped subagents лучше, чем swarm без границ ([Anthropic](https://www.anthropic.com/research/building-effective-agents), [Cursor Agent Best Practices](https://cursor.com/blog/agent-best-practices)).

## Roadmap по времени

| Горизонт | Что делать | Результат |
|---|---|---|
| 1 неделя | Stage A skeleton: `product-clarifier`, `intake-phase`, `product-spec.md`, CLI flag | Можно запускать миссию из raw intent |
| 2-4 недели | Stage C: `debug-phase`, `test-report.json`, rerun gates, eval scenario | Система чинит красные тесты без ручного вмешательства |
| 1-2 месяца | Stage B + D: AST/FTS repo map, security/perf reviewers, MRP | Planner/debugger получают code intelligence, PR имеет evidence pack |
| 2-3 месяца | Stage E + F: PR lifecycle, GitHub checks, budget and permission policies | Overstory становится real async coding agent platform |
| 3-6 месяцев | Stage G: sandbox adapters, eval-as-CI, web auth, pruning | Безопасный unattended mode |
| 6+ месяцев | Stage H: background maintenance, CVE watcher, doc sync, deployer | Платформа начинает сама поддерживать проект |

## Финальная рекомендация

Overstory стоит развивать не как “еще один coding agent”, а как orchestration substrate для autonomous software engineering. Сильная сторона проекта: он уже решает сложные engineering-проблемы, которые многие agent frameworks откладывают на потом: mail-bus, watchdog, recovery, cost metrics, runtime abstraction, review subgraphs и merge tiers.

Первый реальный milestone: raw product intent превращается в reviewed `product-spec.md`, дальше Overstory строит plan, реализует workstreams, сам чинит test failures через debugger, собирает MRP и открывает PR. Когда этот loop стабилен, можно добавлять sandbox, security gates, budget kill-switch и background maintenance agents. После этого система уже будет не MVP, а настоящей автономной dev-платформой с controlled human-in-the-loop.
