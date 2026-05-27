# Gateway providers

Route agent API calls through custom gateway endpoints (z.ai, OpenRouter,
self-hosted proxies). Configure providers in `.overstory/config.yaml`:

```yaml
providers:
  anthropic:
    type: native
  zai:
    type: gateway
    baseUrl: https://api.z.ai/v1
    authTokenEnv: ZAI_API_KEY
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY

models:
  builder: zai/claude-sonnet-4-6
  scout: openrouter/openai/gpt-4o
```

## How it works

Model refs use `provider/model-id` format. Haru sets `ANTHROPIC_BASE_URL` to
the gateway `baseUrl`, `ANTHROPIC_AUTH_TOKEN` from the env var named in
`authTokenEnv`, and `ANTHROPIC_API_KEY=""` to prevent direct Anthropic calls.
The agent receives `"sonnet"` as a model alias and the runtime routes via env
vars.

## Environment variable notes

- `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are mutually exclusive
  per-agent
- Gateway agents get `ANTHROPIC_API_KEY=""` and `ANTHROPIC_AUTH_TOKEN` from
  provider config
- Direct Anthropic API calls (merge resolver, watchdog triage) still need
  `ANTHROPIC_API_KEY` in the orchestrator env

## Validation

```bash
ha doctor --category providers
```

Checks reachability, auth tokens, model-provider refs, and tool-use
compatibility.

## `ProviderConfig` fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `native` or `gateway` | Yes | Provider type |
| `baseUrl` | string | Gateway only | API endpoint URL |
| `authTokenEnv` | string | Gateway only | Env var name holding auth token |
