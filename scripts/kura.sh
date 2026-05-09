#!/usr/bin/env bash
# kura.sh — Rebrand mulch → kura
# Operator runs this from a non-agent terminal post-mission.
# Usage:   bash scripts/kura.sh
# Dry-run: DRY_RUN=1 bash scripts/kura.sh
# Sandbox: SANDBOX=1 SISTER_REPO=/path/to/sandbox/mulch DRY_RUN=1 bash scripts/kura.sh
# SANDBOX=1 skips live-repo guards (remote check, dirty-tree check) for sandbox testing.
set -euo pipefail
export LC_ALL=C
trap 'echo "[ABORT] failed at line $LINENO: $BASH_COMMAND" >&2; git status --short' ERR

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SISTER_REPO="${SISTER_REPO:-/home/liker2/projects/os-eco/mulch}"

STEP=1
TOTAL=25

step() { echo "[STEP $STEP/$TOTAL] $*"; STEP=$((STEP + 1)); }

apply() {
	if [ "${DRY_RUN:-0}" = "1" ]; then
		echo "[dry-run] $*"
	else
		eval "$@"
	fi
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
step "Pre-flight: verify sister repo exists"
if [ ! -d "$SISTER_REPO" ]; then
	echo "[ABORT] sister repo not found at $SISTER_REPO" >&2
	exit 1
fi

cd "$SISTER_REPO"
echo "  cwd: $(pwd)"

# ---------------------------------------------------------------------------
# Pre-flight: remote check (skipped in SANDBOX=1 mode)
# ---------------------------------------------------------------------------
step "Pre-flight: verify git remote (origin must be liker0704/mulch.git, no upstream)"
if [ "${SANDBOX:-0}" = "1" ]; then
	echo "  [sandbox] skipping remote check"
else
	REMOTE_V=$(git remote -v 2>&1)
	if ! echo "$REMOTE_V" | grep -q 'liker0704/mulch.git'; then
		echo "[ABORT] expected origin to contain liker0704/mulch.git" >&2
		echo "$REMOTE_V" >&2
		exit 1
	fi
	if git remote | grep -q '^upstream$'; then
		echo "[ABORT] unexpected 'upstream' remote present" >&2
		git remote -v >&2
		exit 1
	fi
	echo "  remote OK"
fi

# ---------------------------------------------------------------------------
# Pre-flight: working tree must have only .overstory/agent-defs/ mods (D18)
# Portable porcelain parsing — handles all git status code forms (da-newrisk-10)
# Skipped in SANDBOX=1 mode (sandbox clone is always clean)
# ---------------------------------------------------------------------------
step "Pre-flight: working tree must have only .overstory/agent-defs/ mods"
if [ "${SANDBOX:-0}" = "1" ]; then
	echo "  [sandbox] skipping dirty-tree check"
else
	DIRTY=$(git status --porcelain | awk '{
	  if (NF >= 2) {
	    print $2
	    if ($3 == "->") print $4
	  }
	}')
	NON_AGENT_DEFS=$(echo "$DIRTY" | grep -v '^\.overstory/agent-defs/' | grep -v '^$' || true)
	if [ -n "$NON_AGENT_DEFS" ]; then
		echo "[ABORT] non-agent-defs working-tree mods present:" >&2
		echo "$NON_AGENT_DEFS" >&2
		exit 1
	fi
	echo "  working tree OK (only .overstory/agent-defs/ mods)"
fi

# ---------------------------------------------------------------------------
# Pre-flight: ensure dependencies installed (needed for lint/tsc tools)
# Idempotent: fast no-op if node_modules already present
# ---------------------------------------------------------------------------
step "Pre-flight: bun install (ensure dev tools available)"
if [ ! -d node_modules ]; then
	bun install
else
	echo "  node_modules present, skipping install"
fi

# ---------------------------------------------------------------------------
# Pre-flight: baseline quality gates — capture exit codes (da-newrisk-12)
# ---------------------------------------------------------------------------
step "Pre-flight: capture baseline quality-gate exit codes"
set +e
bun test         > /tmp/kura-baseline-test.log 2>&1; BASELINE_TEST_EXIT=$?
bun run lint     > /tmp/kura-baseline-lint.log 2>&1; BASELINE_LINT_EXIT=$?
tsc --noEmit     > /tmp/kura-baseline-tsc.log  2>&1; BASELINE_TSC_EXIT=$?
set -e
echo "  Baseline exits: test=$BASELINE_TEST_EXIT lint=$BASELINE_LINT_EXIT tsc=$BASELINE_TSC_EXIT"
if [ "$BASELINE_TEST_EXIT" -ne 0 ] || [ "$BASELINE_LINT_EXIT" -ne 0 ] || [ "$BASELINE_TSC_EXIT" -ne 0 ]; then
	echo "[ABORT] baseline gates RED — refusing to compound issues" >&2
	cat /tmp/kura-baseline-test.log >&2
	exit 1
fi
echo "  baseline GREEN"

# ---------------------------------------------------------------------------
# Branch
# ---------------------------------------------------------------------------
step "Branch: checkout rebrand-to-kura"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "rebrand-to-kura" ]; then
	step "[skip] already on rebrand-to-kura branch"
else
	apply "git checkout -b rebrand-to-kura"
fi

# ---------------------------------------------------------------------------
# Pre-pass: org-qualified rename @os-eco/mulch-cli → @hana/kura-cli (da-newrisk-08)
# Runs on all files EXCEPT ./package.json (package.json handled explicitly below).
# Must run BEFORE word-boundary pass to prevent @os-eco/kura-cli corruption.
# ---------------------------------------------------------------------------
step "Pre-pass: rewrite @os-eco/mulch-cli → @hana/kura-cli (all files except package.json)"
if grep -rqF '@hana/kura-cli' --include="*.ts" --include="*.md" . 2>/dev/null; then
	echo "  [skip] @hana/kura-cli already present — pre-pass already applied"
else
	find . -type f \( \
		-name "*.ts" -o -name "*.json" -o -name "*.md" \
		-o -name "*.yaml" -o -name "*.yml" -o -name "*.sh" \
	\) \
		-not -path './node_modules/*' \
		-not -path './.git/*' \
		-not -path './bun.lock' \
		-not -path './LICENSE' \
		-print0 | xargs -0 grep -lF '@os-eco/mulch-cli' 2>/dev/null \
	| while IFS= read -r f; do
		if [ "$f" != "./package.json" ]; then
			apply "sed -i 's|@os-eco/mulch-cli|@hana/kura-cli|g' '$f'"
		fi
	done
fi

# Acceptance positive: @hana/kura-cli must now exist in source files
step "Pre-pass verify: @hana/kura-cli is present"
if ! grep -rqF '@hana/kura-cli' --include="*.ts" --include="*.md" . 2>/dev/null; then
	if [ "${DRY_RUN:-0}" != "1" ]; then
		echo "[ABORT] org-qualified pre-pass did not introduce @hana/kura-cli" >&2; exit 1
	fi
fi
# Acceptance negative: @os-eco/kura-cli (corruption form) must be absent
step "Pre-pass verify: @os-eco/kura-cli (corruption) is absent"
if grep -rqF '@os-eco/kura-cli' --include="*.ts" --include="*.json" --include="*.md" . 2>/dev/null; then
	echo "[ABORT] @os-eco/kura-cli appeared — pre-pass logic corrupted org name" >&2; exit 1
fi

# ---------------------------------------------------------------------------
# package.json: targeted field transforms
# ---------------------------------------------------------------------------
step "Transform: package.json fields (name, bin, repository.url, homepage)"
if grep -q '"@hana/kura-cli"' package.json; then
	echo "  [skip] package.json name already @hana/kura-cli"
else
	apply "sed -i 's|\"@os-eco/mulch-cli\"|\"@hana/kura-cli\"|g' package.json"
fi

if grep -q '"kura": "src/cli.ts"' package.json; then
	echo "  [skip] bin.kura already present"
else
	apply "sed -i 's|\"mulch\": \"src/cli.ts\"|\"kura\": \"src/cli.ts\"|g' package.json"
fi

if grep -q '"ku": "src/cli.ts"' package.json; then
	echo "  [skip] bin.ku already present"
else
	apply "sed -i 's|\"ml\": \"src/cli.ts\"|\"ku\": \"src/cli.ts\"|g' package.json"
fi

# ---------------------------------------------------------------------------
# Identifier renames: camelCase and UPPER_CASE embedded identifiers
# Word-boundary pass misses these because adjacent chars are word chars.
# Applied to ALL .ts files (src/ and test/) since these are imported symbols.
# ---------------------------------------------------------------------------
step "Transform: identifier renames (all *.ts) — MULCH_DIR, getMulchDir, initMulchDir, etc."
if grep -rq 'KURA_DIR' src/utils/config.ts 2>/dev/null; then
	echo "  [skip] KURA_DIR already present"
else
	apply "find . -name '*.ts' -not -path './node_modules/*' -print0 | xargs -0 sed -i 's/MULCH_DIR/KURA_DIR/g'"
	apply "find . -name '*.ts' -not -path './node_modules/*' -print0 | xargs -0 sed -i 's/MULCH_README/KURA_README/g'"
	apply "find . -name '*.ts' -not -path './node_modules/*' -print0 | xargs -0 sed -i 's/getMulchDir/getKuraDir/g'"
	apply "find . -name '*.ts' -not -path './node_modules/*' -print0 | xargs -0 sed -i 's/initMulchDir/initKuraDir/g'"
	apply "find . -name '*.ts' -not -path './node_modules/*' -print0 | xargs -0 sed -i 's/mulchDir/kuraDir/g'"
fi

# ---------------------------------------------------------------------------
# src/schemas/config.ts: MulchConfig → KuraConfig
# ---------------------------------------------------------------------------
step "Transform: src/schemas/config.ts — MulchConfig → KuraConfig"
if grep -q 'KuraConfig' src/schemas/config.ts; then
	echo "  [skip] KuraConfig already present"
else
	apply "sed -i 's/MulchConfig/KuraConfig/g' src/schemas/config.ts"
fi

# Propagate KuraConfig rename to all TS source files that import MulchConfig
apply "find src -name '*.ts' -print0 | xargs -0 sed -i 's/MulchConfig/KuraConfig/g'"
# Also propagate to test files
apply "find test -name '*.ts' -print0 | xargs -0 sed -i 's/MulchConfig/KuraConfig/g'"

# ---------------------------------------------------------------------------
# biome.json: .mulch/ → .kura/ in ignore list
# ---------------------------------------------------------------------------
step "Transform: biome.json — .mulch/ → .kura/ in ignore list"
if grep -q '".kura/"' biome.json; then
	echo "  [skip] biome.json already references .kura/"
else
	apply "sed -i 's|\".mulch/\"|\".kura/\"|g' biome.json"
fi

# ---------------------------------------------------------------------------
# .gitattributes: .mulch/expertise → .kura/expertise
# ---------------------------------------------------------------------------
step "Transform: .gitattributes — .mulch/expertise → .kura/expertise"
if grep -q '\.kura/expertise' .gitattributes; then
	echo "  [skip] .gitattributes already references .kura/expertise"
else
	apply "sed -i 's|\.mulch/expertise|\.kura/expertise|g' .gitattributes"
fi

# ---------------------------------------------------------------------------
# Bulk word-boundary pass: lowercase mulch → kura
# Runs after pre-pass (so @os-eco/mulch-cli is already gone) and after
# explicit identifier renames above.
# Excludes: LICENSE, bun.lock, node_modules, .git
# ---------------------------------------------------------------------------
step "Bulk pass: \\bmulch\\b → kura (all text files)"
apply "find . -type f \( \
  -name '*.ts' -o -name '*.json' -o -name '*.md' \
  -o -name '*.yaml' -o -name '*.yml' -o -name '*.sh' \
  -o -name '*.txt' -o -name '*.gitattributes' \
\) \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -not -path './bun.lock' \
  -not -path './LICENSE' \
  -print0 | xargs -0 sed -i 's/\bmulch\b/kura/g'"

# PascalCase pass: Mulch → Kura (getMulchDir style already handled above, this catches docs)
apply "find . -type f \( \
  -name '*.ts' -o -name '*.md' -o -name '*.yaml' -o -name '*.yml' \
\) \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -print0 | xargs -0 sed -i 's/\bMulch\b/Kura/g'"

# UPPER_CASE pass: MULCH → KURA (for any residual upper-case refs in docs)
apply "find . -type f \( \
  -name '*.ts' -o -name '*.md' -o -name '*.yaml' -o -name '*.yml' \
\) \
  -not -path './node_modules/*' \
  -not -path './.git/*' \
  -print0 | xargs -0 sed -i 's/\bMULCH\b/KURA/g'"

# ---------------------------------------------------------------------------
# README.md: add fork attribution near top
# ---------------------------------------------------------------------------
step "Transform: README.md — add fork attribution"
if grep -q 'Forked from jayminwest/mulch' README.md; then
	echo "  [skip] attribution already present"
else
	apply "sed -i '2s/^/\nForked from jayminwest\/mulch under MIT License.\n/' README.md"
fi

# ---------------------------------------------------------------------------
# CHANGELOG.md: add Unreleased entry at top
# ---------------------------------------------------------------------------
step "Transform: CHANGELOG.md — add Unreleased entry"
if grep -q 'Renamed to kura' CHANGELOG.md; then
	echo "  [skip] Unreleased entry already present"
else
	apply "sed -i '1s/^/## [Unreleased] — Renamed to kura\n\n/' CHANGELOG.md"
fi

# ---------------------------------------------------------------------------
# Cross-tool refs in CLAUDE.md, CONTRIBUTING.md, SECURITY.md
# overstory → haru, seeds → suji, canopy → tane
# ---------------------------------------------------------------------------
step "Transform: cross-tool refs (overstory→haru, seeds→suji, canopy→tane)"
for f in CLAUDE.md CONTRIBUTING.md SECURITY.md; do
	if [ -f "$f" ]; then
		apply "sed -i 's/\boverstory\b/haru/g; s/\bOverstory\b/Haru/g' '$f'"
		apply "sed -i 's/\bseeds\b/suji/g; s/\bSeeds\b/Suji/g' '$f'"
		apply "sed -i 's/\bcanopy\b/tane/g; s/\bCanopy\b/Tane/g' '$f'"
	fi
done

# ---------------------------------------------------------------------------
# git mv: .mulch → .kura (idempotent)
# ---------------------------------------------------------------------------
step "git mv: .mulch → .kura (and mulch.config.yaml → kura.config.yaml)"
if [ -d .kura ] && [ ! -d .mulch ]; then
	echo "  [skip] .mulch → .kura already renamed"
elif [ -d .mulch ]; then
	apply "git mv .mulch .kura"
	if [ -f .kura/mulch.config.yaml ]; then
		apply "git mv .kura/mulch.config.yaml .kura/kura.config.yaml"
	fi
elif [ ! -d .mulch ] && [ ! -d .kura ]; then
	echo "  [info] neither .mulch nor .kura present — skipping (repo may not have self-init)"
fi

# ---------------------------------------------------------------------------
# Auto-format: sed transforms can shift line lengths past biome's 100-char
# limit, causing formatter failures. Run biome format --write to normalize.
# ---------------------------------------------------------------------------
step "biome format --write (normalize after sed transforms)"
apply "bunx biome format --write ."

# ---------------------------------------------------------------------------
# bun install: regenerate bun.lock after package.json changes
# ---------------------------------------------------------------------------
step "bun install: regenerate bun.lock"
apply "bun install"

# ---------------------------------------------------------------------------
# Commit
# ---------------------------------------------------------------------------
step "git add -A && commit"
apply "git add -A"
apply "git commit -m 'refactor(rebrand): mulch → kura per mission rebrand-hana-v2'"

# ---------------------------------------------------------------------------
# git push
# ---------------------------------------------------------------------------
step "git push -u origin rebrand-to-kura"
apply "git push -u origin rebrand-to-kura"

# ---------------------------------------------------------------------------
# Post-mod quality gates: compare against baseline (da-newrisk-12)
# ---------------------------------------------------------------------------
step "Post-mod: verify quality gates no worse than baseline"
set +e
bun test         > /tmp/kura-post-test.log 2>&1; POST_TEST_EXIT=$?
bun run lint     > /tmp/kura-post-lint.log 2>&1; POST_LINT_EXIT=$?
tsc --noEmit     > /tmp/kura-post-tsc.log  2>&1; POST_TSC_EXIT=$?
set -e
echo "  Post exits: test=$POST_TEST_EXIT lint=$POST_LINT_EXIT tsc=$POST_TSC_EXIT"
echo "  Baseline:   test=$BASELINE_TEST_EXIT lint=$BASELINE_LINT_EXIT tsc=$BASELINE_TSC_EXIT"

REGRESSION=0
if [ "$POST_TEST_EXIT" -gt "$BASELINE_TEST_EXIT" ]; then
	echo "[WARN] test regression: $BASELINE_TEST_EXIT → $POST_TEST_EXIT" >&2
	cat /tmp/kura-post-test.log >&2
	REGRESSION=1
fi
if [ "$POST_LINT_EXIT" -gt "$BASELINE_LINT_EXIT" ]; then
	echo "[WARN] lint regression: $BASELINE_LINT_EXIT → $POST_LINT_EXIT" >&2
	cat /tmp/kura-post-lint.log >&2
	REGRESSION=1
fi
if [ "$POST_TSC_EXIT" -gt "$BASELINE_TSC_EXIT" ]; then
	echo "[WARN] tsc regression: $BASELINE_TSC_EXIT → $POST_TSC_EXIT" >&2
	cat /tmp/kura-post-tsc.log >&2
	REGRESSION=1
fi
if [ "$REGRESSION" -ne 0 ]; then
	echo "[ABORT] post-mod gates regressed: test $BASELINE_TEST_EXIT→$POST_TEST_EXIT, lint $BASELINE_LINT_EXIT→$POST_LINT_EXIT, tsc $BASELINE_TSC_EXIT→$POST_TSC_EXIT" >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# Success summary
# ---------------------------------------------------------------------------
echo ""
echo "======================================================"
echo "  kura.sh: rebrand complete"
echo "======================================================"
echo "  Branch:  rebrand-to-kura"
echo "  Remote:  origin (liker0704/mulch.git)"
echo ""
echo "  Token diff:"
echo "    mulch refs (before): 864"
AFTER_MULCH=$(grep -rEi --exclude-dir=.git --exclude-dir=node_modules '\bmulch\b' . 2>/dev/null | wc -l || echo "?")
echo "    mulch refs (after):  $AFTER_MULCH"
echo "    kura refs (after):   $(grep -rEi --exclude-dir=.git --exclude-dir=node_modules '\bkura\b' . 2>/dev/null | wc -l || echo '?')"
echo ""
echo "  Quality gates post-mod:"
echo "    bun test:       exit $POST_TEST_EXIT"
echo "    bun run lint:   exit $POST_LINT_EXIT"
echo "    tsc --noEmit:   exit $POST_TSC_EXIT"
echo ""
echo "  Next (operator):"
echo "    cd /home/liker2/projects/os-eco/mulch"
echo "    git checkout main && git merge rebrand-to-kura"
echo "======================================================"
