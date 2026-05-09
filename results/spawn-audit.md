# Bun.spawn closed-list audit

## Pre-execution audit (verifies D11 closed list captures all sites)

Run from worktree root:

```bash
grep -rnE 'Bun\.spawn\(\["(ml|sd|cn)"' --include="*.ts" src/
grep -rnE 'runCommand\(\["(ml|sd|cn)"' --include="*.ts" src/
grep -rnE '"which",\s*"(ml|sd|cn)"' --include="*.ts" src/
```

## Pre-execution results

### Bun.spawn sites found (ml):
- src/mulch/client.test.ts:109 — `Bun.spawn(["ml", "init", ...])`
- src/mulch/client.test.ts:130, 151, 174, 191, 265, 284, 302, 324, 343, 364, 390, 412, 434, 456, 484, 502, 532, 564, 637, 761, 795 — `Bun.spawn(["ml", "add", ...])`

### Bun.spawn sites found (sd):
- src/tracker/seeds.ts:19 — `Bun.spawn(["sd", ...args])`

### runCommand sites found:
- src/mulch/client.ts:476 — `runCommand(["ml", ...args])`
- src/canopy/client.ts:66 — `runCommand(["cn", ...args])`
- src/canopy/client.ts:109 — `runCommand(["cn", ...args])`

### which sites found:
- src/mulch/client.test.ts:58 — `Bun.spawn(["which", "ml"])`
- src/canopy/client.test.ts:55 — `Bun.spawn(["which", "cn"])`

## Closed list sites verified

| Site | Pre-state | Post-state |
|------|-----------|------------|
| src/mulch/client.ts:476 runCommand | `["ml", ...args]` | `["ku", ...args]` |
| src/mulch/client.test.ts:58 which | `["which", "ml"]` | `["which", "ku"]` |
| src/mulch/client.test.ts:109,130,151,174,191,265,284,302,324,343,364,390,412,434,456,484,502,532,564,637,761,795 | `["ml", ...]` | `["ku", ...]` |
| src/canopy/client.ts:66,109 runCommand | `["cn", ...args]` | `["ta", ...args]` |
| src/canopy/client.test.ts:55 which | `["which", "cn"]` | `["which", "ta"]` |
| src/tracker/seeds.ts:19 | `["sd", ...args]` | `["su", ...args]` |
| src/tracker/seeds.test.ts:87,165,281,311,322,366,406 | `["sd", ...]` | `["su", ...]` |
| src/doctor/ecosystem.test.ts:128-215 keys | `"ml"`, `"sd"`, `"cn"` | `"ku"`, `"su"`, `"ta"` |

## New sites discovered (must be ZERO)

(empty list — no new sites found outside the D11 closed list)

## Audit conclusion

All D11 closed-list sites captured. No new sites found. Safe to proceed with Pass 5.
