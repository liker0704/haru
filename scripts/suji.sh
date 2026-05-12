#!/usr/bin/env bash
# suji.sh — Rebrand seeds → suji
# Operator runs this from a non-agent terminal post-mission.
# Usage:    bash scripts/suji.sh
# Dry-run:  DRY_RUN=1 bash scripts/suji.sh
# Sandbox:  SISTER_REPO=/path/to/sandbox/seeds SANDBOX=1 DRY_RUN=1 bash scripts/suji.sh
# No-push:  SKIP_PUSH=1 bash scripts/suji.sh
#
# SANDBOX=1 skips live-repo guards (origin substring, dirty-tree) for sandbox testing.
# SKIP_PUSH=1 skips the final git push (step 22).
set -euo pipefail
export LC_ALL=C
trap 'echo "[ABORT] failed at line $LINENO: $BASH_COMMAND" >&2; git status --short' ERR

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SISTER_REPO="${SISTER_REPO:-/home/liker2/projects/os-eco/seeds}"

STEP=1
TOTAL=22

step() { echo "[STEP $STEP/$TOTAL] $*"; STEP=$((STEP + 1)); }

apply() {
	if [ "${DRY_RUN:-0}" = "1" ]; then
		echo "[dry-run] $*"
	else
		eval "$@"
	fi
}

safe_push() {
	local remote="$1" branch="$2"
	local url
	url=$(git remote get-url "$remote")
	if [ "${SANDBOX:-0}" = "1" ]; then
		case "$url" in
			file://*) ;; # ok
			/*)       ;; # local path is acceptable
			*) echo "[ABORT] SANDBOX=1 but origin is non-local: $url" >&2; exit 1 ;;
		esac
	fi
	apply "git push -u $remote $branch"
}

# ---------------------------------------------------------------------------
# Guard: must not run from inside an agent session
# ---------------------------------------------------------------------------
if [ -n "${OVERSTORY_AGENT_NAME:-}" ]; then
	echo "[ABORT] script must run from non-agent terminal (OVERSTORY_AGENT_NAME='$OVERSTORY_AGENT_NAME')" >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# Pre-flight: repo presence
# ---------------------------------------------------------------------------
if [ ! -d "$SISTER_REPO" ]; then
	echo "[ABORT] sister repo not found at $SISTER_REPO" >&2
	exit 1
fi

cd "$SISTER_REPO"
echo "  cwd: $(pwd)"

if [ "${SANDBOX:-0}" = "1" ]; then
	ORIGINAL_ORIGIN=$(git remote get-url origin 2>/dev/null || echo "")
	SANDBOX_BARE="${SISTER_REPO}/.sandbox-origin.git"
	if [ ! -d "$SANDBOX_BARE" ]; then
		git init --bare "$SANDBOX_BARE" >/dev/null
	fi
	git remote set-url origin "file://$SANDBOX_BARE"
	echo "  [sandbox] origin rewritten: $ORIGINAL_ORIGIN → file://$SANDBOX_BARE"

	# Restore on any exit path: success, error, signal.
	restore_origin() {
		if [ -n "${ORIGINAL_ORIGIN:-}" ]; then
			git remote set-url origin "$ORIGINAL_ORIGIN" 2>/dev/null || true
			echo "  [sandbox] origin restored to: $ORIGINAL_ORIGIN"
		fi
	}
	trap restore_origin EXIT INT TERM ERR
fi

# ---------------------------------------------------------------------------
# Step 1: D17 hardened remote check (seeds-specific — non-negotiable)
# seeds has BOTH origin (liker0704) and upstream (jayminwest).
# A push to the wrong remote would publish branded changes to jayminwest/seeds.
# ---------------------------------------------------------------------------
step "D17 hardened remote check: origin → liker0704/seeds, upstream present"

if [ "${SANDBOX:-0}" = "1" ]; then
	echo "  [sandbox] skipping origin substring check (sandbox origin is local path)"
else
	# (1) Substring match: accept any URL form pointing at liker0704/seeds
	ACTUAL_ORIGIN=$(git remote get-url origin)
	case "$ACTUAL_ORIGIN" in
	  *liker0704/seeds*|*liker0704/seeds.git*) ;;
	  *) echo "[ABORT] origin does not point at liker0704/seeds: $ACTUAL_ORIGIN" >&2; exit 1 ;;
	esac
	echo "  origin OK: $ACTUAL_ORIGIN"
fi

# (2) Hard-fail if upstream is MISSING — D17 rail assumes upstream→jayminwest exists;
# its absence is a configuration drift signal (operator may have removed it; abort
# rather than silently push to a different default).
if ! git remote get-url upstream >/dev/null 2>&1; then
	echo "[ABORT] upstream remote not configured; D17 rail expects upstream→jayminwest" >&2
	exit 1
fi
echo "  upstream present: $(git remote get-url upstream)"

# (3) Verify branch tracking (defensive against config-set push.default surprises).
# Only applicable once the branch exists; skip if it doesn't yet.
if git rev-parse --verify rebrand-to-suji >/dev/null 2>&1; then
	PUSH_REMOTE=$(git config --get branch.rebrand-to-suji.remote 2>/dev/null || echo "origin")
	if [ "$PUSH_REMOTE" != "origin" ]; then
		echo "[ABORT] branch.rebrand-to-suji.remote is '$PUSH_REMOTE', expected 'origin'." >&2
		echo "        seeds has upstream → jayminwest; push must target origin only." >&2
		exit 1
	fi
	echo "  branch.rebrand-to-suji.remote = origin ✓"
fi

# ---------------------------------------------------------------------------
# Step 2: D18 portable porcelain pre-flight
# Broadened carve-out: ^\.overstory/ (seeds has root-level .overstory/ mods:
# README.md, agent-manifest.json, hooks.json — not just agent-defs/).
# Porcelain parsing handles all seven git-status code forms (da-newrisk-10).
# ---------------------------------------------------------------------------
step "Pre-flight: D18 porcelain dirty-tree check (^.overstory/ carve-out)"
if [ "${SANDBOX:-0}" = "1" ]; then
	echo "  [sandbox] skipping dirty-tree check"
else
	DIRTY=$(git status --porcelain | awk '{
	  if (NF >= 2) {
	    print $2
	    if ($3 == "->") print $4
	  }
	}')
	NON_OV=$(echo "$DIRTY" | grep -v '^\.overstory/' | grep -v '^$' || true)
	if [ -n "$NON_OV" ]; then
		echo "[ABORT] non-.overstory working-tree mods present:" >&2
		echo "$NON_OV" >&2
		exit 1
	fi
	echo "  working tree OK (only .overstory/ mods or clean)"
fi

# ---------------------------------------------------------------------------
# Dev tools: ensure bun dev dependencies present for quality-gate commands
# Idempotent: fast no-op if node_modules already present
# ---------------------------------------------------------------------------
if [ ! -d node_modules ]; then
	echo "  [pre-step 3] node_modules absent — running bun install for dev tools"
	bun install
else
	echo "  [pre-step 3] node_modules present"
fi

# ---------------------------------------------------------------------------
# Step 3: Baseline COMPARE — capture exits only
# M2 adapted: WARN-on-baseline-RED, abort ONLY on regression (POST > BASELINE).
# seeds has 16 pre-existing noNonNullAssertion lint warnings → baseline lint=1 expected.
# ---------------------------------------------------------------------------
step "Pre-flight: capture baseline quality-gate exits (M2 adapted — WARN-only on RED)"
set +e; trap '' ERR
bun test         > /tmp/suji-baseline-test.log 2>&1; BASELINE_TEST_EXIT=$?
bun run lint     > /tmp/suji-baseline-lint.log 2>&1; BASELINE_LINT_EXIT=$?
tsc --noEmit     > /tmp/suji-baseline-tsc.log  2>&1; BASELINE_TSC_EXIT=$?
trap 'echo "[ABORT] failed at line $LINENO: $BASH_COMMAND" >&2; git status --short' ERR; set -e
echo "  Baseline exits: test=$BASELINE_TEST_EXIT lint=$BASELINE_LINT_EXIT tsc=$BASELINE_TSC_EXIT"
if [ "$BASELINE_TEST_EXIT" -ne 0 ] || [ "$BASELINE_LINT_EXIT" -ne 0 ] || [ "$BASELINE_TSC_EXIT" -ne 0 ]; then
	echo "  [WARN] baseline RED — seeds has known pre-existing failures (16 noNonNullAssertion warnings)"
	echo "  (M2 adapted: proceeding; only regression on POST vs BASELINE will abort)"
fi

# ---------------------------------------------------------------------------
# Step 4: Branch: checkout/create rebrand-to-suji (idempotent)
# ---------------------------------------------------------------------------
step "Branch: checkout/create rebrand-to-suji"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "rebrand-to-suji" ]; then
	echo "  [skip] already on rebrand-to-suji branch"
else
	apply "git checkout -b rebrand-to-suji"
fi

# ---------------------------------------------------------------------------
# Step 5: Org-qualified pre-pass: @os-eco/seeds-cli → @hana/suji-cli
# Must run BEFORE bulk word-boundary pass to prevent @os-eco/suji-cli corruption.
# Excludes package.json (handled explicitly in step 6).
# Positive + negative grep acceptance checks included.
# ---------------------------------------------------------------------------
step "Pre-pass: rewrite @os-eco/seeds-cli → @hana/suji-cli (all files except package.json)"
if grep -rqF '@hana/suji-cli' --include="*.ts" --include="*.md" . 2>/dev/null; then
	echo "  [skip] @hana/suji-cli already present — pre-pass already applied"
else
	find . -type f \( \
		-name "*.ts" -o -name "*.json" -o -name "*.md" \
		-o -name "*.yaml" -o -name "*.yml" -o -name "*.sh" \
	\) \
		-not -path './node_modules/*' \
		-not -path './.git/*' \
		-not -path './bun.lock' \
		-not -path './LICENSE' \
		-print0 | xargs -0 grep -lF '@os-eco/seeds-cli' 2>/dev/null \
	| while IFS= read -r f; do
		if [ "$f" != "./package.json" ]; then
			apply "sed -i 's|@os-eco/seeds-cli|@hana/suji-cli|g' '$f'"
		fi
	done
fi

# Acceptance positive: @hana/suji-cli must now exist in source files
if ! grep -rqF '@hana/suji-cli' --include="*.ts" --include="*.md" --include="*.json" . 2>/dev/null; then
	if [ "${DRY_RUN:-0}" != "1" ]; then
		echo "[ABORT] org-qualified pre-pass did not introduce @hana/suji-cli" >&2; exit 1
	fi
fi
echo "  pre-pass positive: @hana/suji-cli present ✓"

# Acceptance negative: @os-eco/suji-cli (corruption form) must be absent
if grep -rqF '@os-eco/suji-cli' --include="*.ts" --include="*.json" --include="*.md" . 2>/dev/null; then
	echo "[ABORT] @os-eco/suji-cli appeared — pre-pass logic corrupted org name" >&2; exit 1
fi
echo "  pre-pass negative: @os-eco/suji-cli absent ✓"

# ---------------------------------------------------------------------------
# Step 6: package.json explicit transforms
# name → @hana/suji-cli; bin sd → su; homepage/bugs.url/repository.url → liker0704/suji
# Note: jayminwest/seeds in package.json → liker0704/suji (package is now liker0704's)
# ---------------------------------------------------------------------------
step "Transform: package.json (name, bin sd→su, urls → liker0704/suji)"
if grep -qF '"@hana/suji-cli"' package.json; then
	echo "  [skip] package.json name already @hana/suji-cli"
else
	apply "sed -i 's|\"@os-eco/seeds-cli\"|\"@hana/suji-cli\"|g' package.json"
fi
if grep -qF '"su"' package.json && ! grep -qF '"sd"' package.json; then
	echo "  [skip] bin su already present"
else
	apply "sed -i 's|\"sd\": \"./src/index.ts\"|\"su\": \"./src/index.ts\"|g' package.json"
fi
apply "sed -i 's|jayminwest/seeds|liker0704/suji|g' package.json"

# ---------------------------------------------------------------------------
# Step 7: src/types.ts SEEDS_DIR_NAME → SUJI_DIR_NAME (def + all *.ts refs)
# Uppercase identifier; not caught by lowercase \bseeds\b bulk pass.
# ---------------------------------------------------------------------------
step "Transform: SEEDS_DIR_NAME → SUJI_DIR_NAME (src/types.ts def + all *.ts refs)"
if grep -rqF 'SUJI_DIR_NAME' src/types.ts 2>/dev/null; then
	echo "  [skip] SUJI_DIR_NAME already present in src/types.ts"
else
	apply "find . -name '*.ts' -not -path './node_modules/*' -print0 | xargs -0 sed -i 's/SEEDS_DIR_NAME/SUJI_DIR_NAME/g'"
fi

# ---------------------------------------------------------------------------
# Step 8: src/config.ts default project ?? "seeds" → ?? "suji"
# ---------------------------------------------------------------------------
step "Transform: src/config.ts — default project ?? \"seeds\" → ?? \"suji\""
if grep -qF '"suji"' src/config.ts; then
	echo "  [skip] src/config.ts default already suji"
else
	apply "sed -i 's|data.project ?? \"seeds\"|data.project ?? \"suji\"|g' src/config.ts"
fi

# ---------------------------------------------------------------------------
# Step 9: src/index.ts — program.name("sd") → "su" and Usage: sd → su
# Targeted: .ts is excluded from bulk \bsd\b → su pass (D4 carve-out).
# ---------------------------------------------------------------------------
step "Transform: src/index.ts — program.name(\"sd\") → \"su\", Usage: sd <command> → su"
if grep -qF '.name("su")' src/index.ts; then
	echo "  [skip] program.name already su in src/index.ts"
else
	apply "sed -i 's/.name(\"sd\")/.name(\"su\")/g' src/index.ts"
fi
apply "sed -i 's/Usage: sd <command>/Usage: su <command>/g' src/index.ts"

# ---------------------------------------------------------------------------
# Step 10: D5 fixture flip — src/id.test.ts generateId("overstory") → generateId("haru")
# Only this specific "overstory" string needs flipping in the seeds repo.
# ---------------------------------------------------------------------------
step "D5 fixture flip: src/id.test.ts generateId(\"overstory\") → generateId(\"haru\") + assertion"
if grep -qF 'generateId("haru"' src/id.test.ts; then
	echo "  [skip] generateId(\"haru\") already present"
else
	apply "sed -i 's/generateId(\"overstory\"/generateId(\"haru\"/g' src/id.test.ts"
	# Also update the startsWith assertion to match the new prefix
	apply "sed -i 's/startsWith(\"overstory-\")/startsWith(\"haru-\")/g' src/id.test.ts"
fi

# ---------------------------------------------------------------------------
# Step 11: Test temp-dir prefixes
# seeds-config-test- → suji-config-test-, seeds-store-test- → suji-store-test-
# ---------------------------------------------------------------------------
step "Transform: test temp-dir prefixes (seeds-*-test- → suji-*-test-)"
if grep -qF 'suji-config-test-' src/config.test.ts; then
	echo "  [skip] config.test.ts prefix already suji"
else
	apply "sed -i 's|seeds-config-test-|suji-config-test-|g' src/config.test.ts"
fi
if grep -qF 'suji-store-test-' src/store.test.ts; then
	echo "  [skip] store.test.ts prefix already suji"
else
	apply "sed -i 's|seeds-store-test-|suji-store-test-|g' src/store.test.ts"
fi

# ---------------------------------------------------------------------------
# Step 12: src/yaml.test.ts — project literal "seeds" → "suji"
# These test values use "seeds" as project name string, not tool name.
# ---------------------------------------------------------------------------
step "Transform: src/yaml.test.ts — project literal \"seeds\" → \"suji\""
if grep -qF '"suji"' src/yaml.test.ts; then
	echo "  [skip] yaml.test.ts already references suji"
else
	apply "sed -i 's/project: seeds/project: suji/g' src/yaml.test.ts"
	apply "sed -i 's/\"seeds\"/\"suji\"/g' src/yaml.test.ts"
fi

# ---------------------------------------------------------------------------
# Step 13: Bulk pass — sentinel-mask + \bseeds\b → suji + PascalCase + UPPER
# Phase A: mask jayminwest/seeds (fork attribution lines must stay as jayminwest/seeds)
# Phase B: bulk lowercase \bseeds\b → suji, PascalCase \bSeeds\b → Suji, UPPER \bSEEDS\b → SUJI
# Phase C: unmask sentinel back to jayminwest/seeds
# LICENSE excluded; bun.lock excluded.
# ---------------------------------------------------------------------------
step "Bulk pass (A/B/C): sentinel-mask jayminwest/seeds; \bseeds\b → suji; unmask"
SENTINEL="__JAYMINWEST_SEEDS_SENTINEL__"

# Phase A: mask jayminwest/seeds to preserve fork-attribution lines
apply "find . -type f \( \
  -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.yaml' -o -name '*.yml' \
  -o -name '*.sh' -o -name '.gitattributes' \
\) \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -not -path './bun.lock' \
  -not -path './LICENSE' \
  -print0 | xargs -0 sed -i 's|jayminwest/seeds|$SENTINEL|g'"

# Phase B: bulk lowercase, PascalCase, UPPER passes
apply "find . -type f \( \
  -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.yaml' -o -name '*.yml' \
  -o -name '*.sh' -o -name '.gitattributes' \
\) \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -not -path './bun.lock' \
  -not -path './LICENSE' \
  -print0 | xargs -0 sed -i 's/\bseeds\b/suji/g'"
apply "find . -type f \( \
  -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.yaml' -o -name '*.yml' \
\) \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -print0 | xargs -0 sed -i 's/\bSeeds\b/Suji/g'"
apply "find . -type f \( \
  -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.yaml' -o -name '*.yml' \
\) \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -print0 | xargs -0 sed -i 's/\bSEEDS\b/SUJI/g'"

# Phase C: unmask sentinel back to jayminwest/seeds
apply "find . -type f \( \
  -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.yaml' -o -name '*.yml' \
  -o -name '*.sh' -o -name '.gitattributes' \
\) \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -not -path './bun.lock' \
  -not -path './LICENSE' \
  -print0 | xargs -0 sed -i 's|$SENTINEL|jayminwest/seeds|g'"

# ---------------------------------------------------------------------------
# Step 14: Bulk \.seeds/ → \.suji/ in *.ts/*.md/*.json/*.yml/*.yaml + .gitattributes
# Covers path-like references (including .gitattributes merge=union entries).
# ---------------------------------------------------------------------------
step "Bulk pass: \.seeds/ → \.suji/ (*.ts/*.md/*.json/*.yml/*.yaml + .gitattributes)"
apply "find . -type f \( \
  -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.yaml' -o -name '*.yml' \
  -o -name '.gitattributes' \
\) \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -not -path './LICENSE' \
  -print0 | xargs -0 sed -i 's|\.seeds/|\.suji/|g'"

# ---------------------------------------------------------------------------
# Step 15: Bulk \bsd\b → su in *.md ONLY
# D4 carve-out: NEVER touch *.ts (migrate-from-beads string literals must stay).
# The \bsd\b pass naturally leaves migrate.ts untouched.
# ---------------------------------------------------------------------------
step "Bulk pass: \bsd\b → su in *.md ONLY (D4 carve-out: never *.ts)"
apply "find . -type f -name '*.md' \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -not -path './LICENSE' \
  -print0 | xargs -0 sed -i 's/\bsd\b/su/g'"

# ---------------------------------------------------------------------------
# Step 16: git mv .seeds → .suji (idempotent)
# ---------------------------------------------------------------------------
step "git mv: .seeds → .suji (idempotent)"
if [ -d .suji ] && [ ! -d .seeds ]; then
	echo "  [skip] .seeds → .suji already renamed"
elif [ -d .seeds ]; then
	apply "git mv .seeds .suji"
elif [ ! -d .seeds ] && [ ! -d .suji ]; then
	echo "  [info] neither .seeds nor .suji present — skipping (repo may not have self-init)"
fi

# ---------------------------------------------------------------------------
# Step 17: README.md fork attribution — insert after first H1 if absent (idempotent)
# ---------------------------------------------------------------------------
step "Transform: README.md — add fork attribution (jayminwest/seeds)"
if grep -qF 'Forked from jayminwest/seeds' README.md; then
	echo "  [skip] attribution already present"
else
	apply "sed -i '2s/^/\nForked from jayminwest\/seeds under MIT License.\n/' README.md"
fi

# ---------------------------------------------------------------------------
# Step 18: CHANGELOG.md — prepend ## [Unreleased] — Renamed to suji (idempotent)
# ---------------------------------------------------------------------------
step "Transform: CHANGELOG.md — prepend '## [Unreleased] — Renamed to suji'"
if grep -qF 'Renamed to suji' CHANGELOG.md; then
	echo "  [skip] Unreleased entry already present"
else
	apply "sed -i '2s/^/## [Unreleased] — Renamed to suji\n\n/' CHANGELOG.md"
fi

# ---------------------------------------------------------------------------
# Step 19: bun install (D15) + biome format --write (normalize after sed transforms)
# sed transforms can shift line lengths past biome's 100-char limit.
# biome format normalizes before commit so lint exit stays at baseline.
# ---------------------------------------------------------------------------
step "bun install: regenerate bun.lock + biome format --write"
apply "bun install"
apply "bunx biome format --write ."

# ---------------------------------------------------------------------------
# Step 20: git add -A && commit
# ---------------------------------------------------------------------------
step "git add -A && commit"
apply "git add -A"
apply "git commit -m 'refactor(rebrand): seeds → suji per mission rebrand-hana-v2'"

# ---------------------------------------------------------------------------
# Step 21: Post-mod COMPARE gates — abort if POST > BASELINE (da-newrisk-12)
# M2 adapted: regression check only (POST > BASELINE); baseline RED is OK.
# ---------------------------------------------------------------------------
step "Post-mod: verify quality gates no worse than baseline"
set +e; trap '' ERR
bun test         > /tmp/suji-post-test.log 2>&1; POST_TEST_EXIT=$?
bun run lint     > /tmp/suji-post-lint.log 2>&1; POST_LINT_EXIT=$?
tsc --noEmit     > /tmp/suji-post-tsc.log  2>&1; POST_TSC_EXIT=$?
trap 'echo "[ABORT] failed at line $LINENO: $BASH_COMMAND" >&2; git status --short' ERR; set -e
echo "  Post exits:     test=$POST_TEST_EXIT lint=$POST_LINT_EXIT tsc=$POST_TSC_EXIT"
echo "  Baseline exits: test=$BASELINE_TEST_EXIT lint=$BASELINE_LINT_EXIT tsc=$BASELINE_TSC_EXIT"

REGRESSION=0
if [ "$POST_TEST_EXIT" -gt "$BASELINE_TEST_EXIT" ]; then
	echo "[WARN] test regression: $BASELINE_TEST_EXIT → $POST_TEST_EXIT" >&2
	cat /tmp/suji-post-test.log >&2
	REGRESSION=1
fi
if [ "$POST_LINT_EXIT" -gt "$BASELINE_LINT_EXIT" ]; then
	echo "[WARN] lint regression: $BASELINE_LINT_EXIT → $POST_LINT_EXIT" >&2
	cat /tmp/suji-post-lint.log >&2
	REGRESSION=1
fi
if [ "$POST_TSC_EXIT" -gt "$BASELINE_TSC_EXIT" ]; then
	echo "[WARN] tsc regression: $BASELINE_TSC_EXIT → $POST_TSC_EXIT" >&2
	cat /tmp/suji-post-tsc.log >&2
	REGRESSION=1
fi
if [ "$REGRESSION" -ne 0 ]; then
	echo "[ABORT] post-mod gates regressed: test $BASELINE_TEST_EXIT→$POST_TEST_EXIT, lint $BASELINE_LINT_EXIT→$POST_LINT_EXIT, tsc $BASELINE_TSC_EXIT→$POST_TSC_EXIT" >&2
	exit 1
fi
echo "  post-mod gates: no regression ✓"

# ---------------------------------------------------------------------------
# Step 22: Remote publish — gated by SKIP_PUSH=1 escape hatch
# Uses literal command from seeds brief line 54: git push -u origin rebrand-to-suji
# ---------------------------------------------------------------------------
step "Remote publish: git push -u origin rebrand-to-suji (SKIP_PUSH=${SKIP_PUSH:-0})"
if [ "${SKIP_PUSH:-0}" = "1" ]; then
	echo "  [SKIP_PUSH=1] skipping remote publish — run manually: git push -u origin rebrand-to-suji"
else
	safe_push origin rebrand-to-suji
fi

# ---------------------------------------------------------------------------
# Success summary
# ---------------------------------------------------------------------------
echo ""
echo "======================================================"
echo "  suji.sh: rebrand complete"
echo "======================================================"
echo "  Branch:  rebrand-to-suji"
echo "  Remote:  origin (liker0704/seeds → suji)"
echo ""
echo "  Token diff:"
AFTER_SEEDS=$(grep -rEi --exclude-dir=.git --exclude-dir=node_modules '\bseeds\b' . 2>/dev/null | wc -l || echo "?")
echo "    seeds refs before: 299 (baseline)"
echo "    seeds refs after:  $AFTER_SEEDS"
AFTER_SUJI=$(grep -rEi --exclude-dir=.git --exclude-dir=node_modules '\bsuji\b' . 2>/dev/null | wc -l || echo "?")
echo "    suji refs after:   $AFTER_SUJI"
echo ""
echo "  Quality gates post-mod:"
echo "    bun test:       exit $POST_TEST_EXIT"
echo "    bun run lint:   exit $POST_LINT_EXIT"
echo "    tsc --noEmit:   exit $POST_TSC_EXIT"
echo ""
echo "  Next (operator):"
echo "    cd /home/liker2/projects/os-eco/seeds"
echo "    git checkout main && git merge rebrand-to-suji && git push origin main"
echo "======================================================"
