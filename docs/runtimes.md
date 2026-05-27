# Runtime adapters

Haru is runtime-agnostic. The `AgentRuntime` interface
(`src/runtimes/types.ts`) defines the contract — each adapter handles spawning,
config deployment, guard enforcement, readiness detection, and transcript
parsing for its runtime.

Set the default in `.overstory/config.yaml` or override per-agent with
`ha sling --runtime <name>`.

## Supported runtimes

| Runtime | CLI | Guard mechanism | Stability |
|---------|-----|-----------------|-----------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `claude` | `settings.local.json` hooks | Stable |
| [Sapling](https://github.com/jayminwest/sapling) | `sp` | `.sapling/guards.json` | Stable |
| [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) | `pi` | `.pi/extensions/` guard extension | Experimental |
| [GitHub Copilot](https://github.com/features/copilot) | `copilot` | none (`--allow-all-tools`) | Experimental |
| [Cursor CLI](https://cursor.com/docs/cli/overview) | `agent` | none (`--yolo`) | Experimental |
| [Codex](https://github.com/openai/codex) | `codex` | OS-level sandbox (Seatbelt/Landlock) | Experimental |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini` | `--sandbox` flag | Experimental |
| [OpenCode](https://opencode.ai) | `opencode` | none | Experimental |

## Configuration

```yaml
runtime:
  default: claude

  # Per-capability override
  capabilities:
    scout: claude
    builder: claude

  # Headless one-shot AI calls (merge resolver, watchdog triage)
  printCommand: claude
```

## Adding a runtime

Implement the `AgentRuntime` interface from `src/runtimes/types.ts` and
register it in `src/runtimes/registry.ts`. Key methods:

- `deployInstructions()` — write per-agent config files
- `buildSpawnCommand()` — assemble the tmux command line
- `requiresBeaconVerification()` — does the runtime need an extra readiness
  probe

Pattern references: `src/runtimes/sapling.ts` (simple headless),
`src/runtimes/claude.ts` (full interactive).
