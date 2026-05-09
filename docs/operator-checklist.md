# mission-1778354709476-rebrand-hana-v2 — Operator Checklist

## 1. Summary

**Mission ID:** `mission-1778354709476-rebrand-hana-v2`
**Predecessor:** `mission-1778345236437-rebrand-hana` (suspended pre-#209 fix)
**Tracking issue:** GitHub `liker0704/overstory#189`

This mission rebranded the os-eco tool suite in-place:

- `overstory` → `haru` (applied in-place during the mission; operator runs the final disk + GitHub rename)
- `mulch` → `kura` (operator runs `scripts/kura.sh`)
- `seeds` → `suji` (operator runs `scripts/suji.sh`)
- `canopy` → `tane` (operator runs `scripts/tane.sh`)

**Key v3 redesign (D20 — operator-runs-script model):** The original design assumed mission-context leads could run bash directly inside the target repos. This was technically infeasible — agent hooks fire in any terminal with `OVERSTORY_AGENT_NAME` set, making direct shell execution inside a live overstory session unsafe. The corrected model: the operator runs the pre-built rebrand scripts from a non-agent terminal after the mission completes.

For full rationale and decision log, see:

- `decisions.md` (D1–D25)
- `research/_summary.md`

---

## 2. Pre-flight checks

```bash
# 2a. Stop watchdog daemon (closes da-d13-gap-04 stale-hooks window)
ov watch stop || true                             # tier-0 watchdog
ov status                                         # confirm no agents running

# 2b. No cron / schedules
crontab -l 2>/dev/null | grep -E "(ov |overstory)" || echo "OK: no cron"

# 2c. Each sibling repo state check
for d in mulch seeds canopy; do
  echo "=== $d ==="
  cd /home/liker2/projects/os-eco/$d
  git status --short
  git remote -v
done

# 2d. Operator MUST run scripts from a non-agent terminal
unset OVERSTORY_AGENT_NAME OVERSTORY_RUNTIME_SESSION_ID
echo "OVERSTORY_AGENT_NAME='$OVERSTORY_AGENT_NAME'"   # must print empty

# 2e. CRITICAL — clean stale rebrand-to-<new> branches on GitHub before running scripts.
# During the mission's mandatory M6 sandbox dry-runs, sandbox clones inherited each
# sister-repo's live origin URL; lead-canopy-to-tane confirmed (mission_finding
# msg-ir0rzlct7z74 / msg-u8f9ii1v0yoy) that the rebrand-to-tane branch was published
# to liker0704/canopy.git. mulch and seeds may have produced the same side-effect.
# Each script will attempt to create + push the SAME branch name; without cleanup,
# the script's `git push -u origin rebrand-to-<new>` either fast-forwards onto the
# stale ref (mixing dry-run and real commits) or fails with non-fast-forward.
# DELETE the stale refs before running scripts:
for pair in 'canopy:rebrand-to-tane' 'mulch:rebrand-to-kura' 'seeds:rebrand-to-suji'; do
  REPO="${pair%:*}"; BRANCH="${pair#*:}"
  if gh api "repos/liker0704/$REPO/git/refs/heads/$BRANCH" >/dev/null 2>&1; then
    echo "[stale-ref] deleting refs/heads/$BRANCH on liker0704/$REPO"
    gh api -X DELETE "repos/liker0704/$REPO/git/refs/heads/$BRANCH"
  else
    echo "[stale-ref] none for liker0704/$REPO/refs/heads/$BRANCH"
  fi
done
# Also cleanup local tracking refs (if your local clone has fetched the stale branch):
for pair in 'mulch:rebrand-to-kura' 'seeds:rebrand-to-suji' 'canopy:rebrand-to-tane'; do
  d="${pair%:*}"; b="${pair#*:}"
  cd /home/liker2/projects/os-eco/$d
  git fetch --prune origin
  git branch -D "$b" 2>/dev/null || true
done
```

---

## 3. Run the three sister-repo rebrand scripts + paired GitHub renames

Each script invocation is followed by `gh repo rename` per operator constraint 5. Overstory's disk + GitHub rename happens LAST (section 6).

```bash
# Run from a non-agent terminal where OVERSTORY_AGENT_NAME is unset → no hooks fire
unset OVERSTORY_AGENT_NAME OVERSTORY_RUNTIME_SESSION_ID

# Optional: dry-run first (operator constraint 3) — verify intended changes
DRY_RUN=1 bash /home/liker2/projects/os-eco/overstory/scripts/kura.sh
DRY_RUN=1 bash /home/liker2/projects/os-eco/overstory/scripts/suji.sh
DRY_RUN=1 bash /home/liker2/projects/os-eco/overstory/scripts/tane.sh

# 3a. mulch → kura (no upstream remote)
cd /home/liker2/projects/os-eco/overstory
bash scripts/kura.sh
# Script self-verifies: pre-flight + body + bun test + bun run lint + tsc --noEmit; exits non-zero on failure
cd /home/liker2/projects/os-eco/mulch && git checkout main && git merge rebrand-to-kura && git push origin main
gh repo rename kura

# 3b. seeds → suji (D17: script's internal guard ensures push to origin only — never to jayminwest upstream)
cd /home/liker2/projects/os-eco/overstory
bash scripts/suji.sh
cd /home/liker2/projects/os-eco/seeds && git checkout main && git merge rebrand-to-suji && git push origin main   # NEVER upstream
gh repo rename suji

# 3c. canopy → tane
cd /home/liker2/projects/os-eco/overstory
bash scripts/tane.sh
cd /home/liker2/projects/os-eco/canopy && git checkout main && git merge rebrand-to-tane && git push origin main
gh repo rename tane

# Overstory rebrand was applied in-place during the mission; final disk + gh rename happens in section 6.
```

Each script: idempotent (re-runnable), supports `DRY_RUN=1`, baseline-checks the sister repo before mutation, structured `[STEP n/m]` output. See `decisions.md` D25 + operator-constraints-1-8.

---

## 4. Apply install.sh patch

```bash
cd /home/liker2/projects/os-eco/overstory
bash scripts/fix-install-sh.sh    # patches /home/liker2/projects/os-eco/install.sh
```

---

## 5. Sister-repo disk renames

```bash
mv /home/liker2/projects/os-eco/mulch  /home/liker2/projects/os-eco/kura
mv /home/liker2/projects/os-eco/seeds  /home/liker2/projects/os-eco/suji
mv /home/liker2/projects/os-eco/canopy /home/liker2/projects/os-eco/tane
```

---

## 6. Final overstory disk + GitHub rename

This MUST run BEFORE any subsequent `cd /haru` reference. The operator must NOT have any active session inside `/overstory` at this point.

```bash
# so-cwd-fragility-section6-rev3 fix: defensive parent-dir cd before mv so the
# shell does not end up in a phantom cwd (the just-renamed source path).
cd /home/liker2/projects/os-eco
mv /home/liker2/projects/os-eco/overstory /home/liker2/projects/os-eco/haru
cd /home/liker2/projects/os-eco/haru
gh repo rename haru
```

---

## 7. Global binary reinstall

By now `/haru` exists (section 6) and is safe to `cd` into.

```bash
cd /home/liker2/projects/os-eco/kura  && bun install && bun install -g .
cd /home/liker2/projects/os-eco/suji  && bun install && bun install -g .
cd /home/liker2/projects/os-eco/tane  && bun install && bun install -g .
cd /home/liker2/projects/os-eco/haru  && bun install && bun install -g .
```

---

## 8. Regenerate orchestrator state

```bash
cd /home/liker2/projects/os-eco/haru
ha hooks install                                  # regenerates .overstory/hooks.json
ha update                                         # refreshes managed files (agent-manifest.json)
# Verification (LOW so-handoff-fail-detection-rev2 fix: explicit exit codes, not && chains)
if grep -qE "OVERSTORY_" .overstory/hooks.json; then
  echo "[FAIL] stale OVERSTORY_ refs in hooks.json"; exit 1
fi
echo "[OK] hooks.json clean"
if grep -qE "\bov " .overstory/agent-manifest.json; then
  echo "[FAIL] stale ov refs in manifest"; exit 1
fi
echo "[OK] manifest clean"
# NOW it is safe to restart the watchdog
ha watch start
```

---

## 9. Optional cleanup of OLD global binaries

```bash
which ov ml sd cn 2>/dev/null
# rm -f $(which ov) $(which ml) $(which sd) $(which cn) 2>/dev/null
```

---

## 10. Verification (smoke tests)

```bash
haru --version
ku --version
su --version
ta --version

cd /home/liker2/projects/os-eco/haru && bun test
cd /home/liker2/projects/os-eco/kura && bun test
cd /home/liker2/projects/os-eco/suji && bun test
cd /home/liker2/projects/os-eco/tane && bun test
```

---

## 11. Post-execution verification

```bash
# Run from a non-agent terminal. Aborts on first straggler found.
SAW_STRAGGLER=0
for d in kura suji tane haru; do
  echo "=== $d ==="
  cd /home/liker2/projects/os-eco/$d
  # No old-token straggler refs (D21 PCRE lookbehind for .overstory carve-out)
  if grep -rPi --exclude-dir=.git --exclude-dir=.overstory --exclude-dir=node_modules \
       "(?<!\.)\b(overstory|mulch|seeds|canopy)\b" --include="*.ts" . | head -5; then
    echo "[FAIL] $d has old-token stragglers"; SAW_STRAGGLER=1
  fi
  # No old short-CLI refs (allow CHANGELOG + migrate-from-beads literal)
  if grep -rE --exclude-dir=.git --exclude-dir=.overstory --exclude-dir=node_modules \
       "\b(ov|ml|sd|cn) " --include="*.md" . | grep -v 'CHANGELOG' | grep -v 'migrate-from-beads' | head -5; then
    echo "[FAIL] $d has old short-CLI stragglers"; SAW_STRAGGLER=1
  fi
done
[ "$SAW_STRAGGLER" = 0 ] || { echo "[ABORT] verification found stragglers"; exit 1; }
echo "[OK] no stragglers across all 4 repos"
```

**Expected-skip allow-list (D23):** The following are known-non-issues the operator may safely tolerate — they are publish-dependency artifacts, not rebrand defects:

- `src/mulch/client.test.ts` — `which ku` absent until `@hana/kura-cli` published
- `src/canopy/client.test.ts` — `which ta` absent until `@hana/tane-cli` published
- `evals/**` that shell to `ov`/`ha`
- `upgrade.test.ts` referencing `@hana/kura-cli` from npm registry (publish-dependency, not a transform bug)

---

## 12. Close the GitHub tracking issue

```bash
gh issue close 189 --repo liker0704/haru \
  --comment "Mission rebrand-hana-v2 complete. Renamed overstory→haru, mulch→kura, seeds→suji, canopy→tane. See haru/.overstory/missions/mission-1778354709476-rebrand-hana-v2 for artifacts."
```

---

## 13. Rollback notes

- Local rollback (before push): `git reset --hard <pre-mission-sha>` per repo.
- Directory rollback: `mv` back; `gh repo rename` back; reinstall old binaries.
- Selective revert: each rename WS landed as a single merge commit per repo; `git revert` of those commits.
- `.overstory/hooks.json` regen failure: run `ov init` (legacy `ov` if still installed) or hand-edit `OVERSTORY_*` → `HARU_*`.

---

## 14. Notes & known carve-outs

- `.overstory/` state directory inside `haru` repo intentionally NOT renamed (later mission).
- `beads` was out of scope and is unchanged.
- `migrate-from-beads` command in `suji` keeps that exact name (D4).
- `OVERSTORY_*` env vars renamed to `HARU_*`. Update local shell scripts / `.envrc` / IDE settings.
- `package.json` `dependencies."@os-eco/mulch-cli"` STAYS (D8) — transitive npm dep, not republished.
- `seeds` repo has `upstream → jayminwest/seeds.git`. Push to `origin` only (D17).
- Old npm package names remain unpublished in this mission. Operator may publish `@hana/*` later.
