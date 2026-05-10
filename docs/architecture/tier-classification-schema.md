# Tier classification schema

The `tier-classifier` agent (Haiku, ephemeral) records every classification
decision to kura under the `tier-classifier` domain. Each record is one
mission's tier decision plus the signals that drove it. Over time the
collection becomes labeled training data for future rule extraction or a
fine-tuned classifier.

## Record fields

Records are persisted via:

```bash
ku record tier-classifier \
  --type decision \
  --classification observational \
  --description '<JSON payload — see schema below>' \
  --outcome-agent tier-classifier \
  --outcome-status success
```

The `--description` payload is a single-line JSON object with this shape:

```json
{
  "missionId": "haru-XXXX",
  "intentExcerpt": "first 500 chars of raw intent",
  "signals": {
    "fileCount": 8,
    "hasApiChange": false,
    "hasAuthChange": false,
    "hasMigration": false,
    "hasBilling": false,
    "hasBreakingChange": false,
    "hasSecurityCritical": false,
    "crossComponentDeps": 2,
    "ambiguity": "low"
  },
  "tier": "planned",
  "rationale": "Multi-file refactor without API/auth/billing impact; 2 cross-component edges suggest planned tier.",
  "confidence": "high"
}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `missionId` | string | Foreign key into missions table |
| `intentExcerpt` | string | First 500 chars of raw `--from-intent` text |
| `signals.fileCount` | int | Estimated file count from spec scope + research |
| `signals.hasApiChange` | bool | Public API surface modified |
| `signals.hasAuthChange` | bool | Auth/AuthZ/AuthN code touched |
| `signals.hasMigration` | bool | DB migration required |
| `signals.hasBilling` | bool | Billing/payments touched |
| `signals.hasBreakingChange` | bool | ABI/contract break |
| `signals.hasSecurityCritical` | bool | Crypto / secrets / sensitive flow |
| `signals.crossComponentDeps` | int | Distinct components / modules touched |
| `signals.ambiguity` | enum | `low` / `medium` / `high` |
| `tier` | enum | `direct` / `planned` / `full` |
| `rationale` | string | Free-form explanation referencing signals |
| `confidence` | enum | `low` / `medium` / `high` |

## Heuristics (seed rules — refined over time)

```
direct:  fileCount ≤ 3
         AND ambiguity = low
         AND none of (hasApiChange, hasAuthChange, hasMigration,
                      hasBilling, hasBreakingChange, hasSecurityCritical)

planned: bounded scope, no security-critical
         AND (hasApiChange OR crossComponentDeps > 2)

full:    hasAuthChange OR hasMigration OR hasBilling
         OR hasSecurityCritical OR ambiguity = high
```

These are intentionally conservative on the `full` side — when in doubt,
escalate. Refinement happens after enough kura records accumulate.

## Outcome status semantics

| Outcome | When |
|---|---|
| `success` | Mission completed at the same tier (no escalation/downgrade) |
| `failure` | Mission required tier escalation or downgrade — original classification was wrong |

After `ha mission complete`, follow up with:

```bash
# If tier was correct
ku record tier-classifier --type decision --classification observational \
  --description '...' --outcome-agent tier-classifier --outcome-status success

# If tier was escalated mid-mission
ku record tier-classifier --type decision --classification observational \
  --description '... reason: under-classified — discovered API break in workstream X' \
  --outcome-agent tier-classifier --outcome-status failure
```

## Future extraction path

After ~50–100 records:

1. **Rule extraction.** Analyze field-tier correlations. Move deterministic
   rules into `src/missions/risk-tier.ts` so the agent becomes a fallback
   for ambiguous cases.
2. **Model fine-tune.** Use the labeled records as training data for a
   tier-classifier fine-tune (cheap model + classification head).
3. **Confidence-gated routing.** High-confidence deterministic rules apply
   without LLM invocation; low-confidence cases fall through to the agent.

The schema is stable across these phases — only the consumer changes.
