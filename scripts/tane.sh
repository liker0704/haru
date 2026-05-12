#!/usr/bin/env bash
# scripts/tane.sh — deterministic rebrand script: canopy → tane
# Operator invocation (from non-agent terminal, after mission):
#   unset OVERSTORY_AGENT_NAME OVERSTORY_RUNTIME_SESSION_ID
#   bash /path/to/overstory/scripts/tane.sh
# Sandbox mode:
#   SISTER_REPO=/path/to/sandbox/canopy bash scripts/tane.sh
# Dry-run mode:
#   SISTER_REPO=/path/to/sandbox/canopy DRY_RUN=1 bash scripts/tane.sh

set -euo pipefail
LC_ALL=C

SISTER_REPO="${SISTER_REPO:-/home/liker2/projects/os-eco/canopy}"

STEP=1
TOTAL=16

step() { echo "[STEP $STEP/$TOTAL] $*"; STEP=$((STEP+1)); }

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

err() { echo "[ABORT] $*" >&2; exit 1; }

trap 'echo "[ABORT] failed at line $LINENO: $BASH_COMMAND" >&2; git -C "$SISTER_REPO" status --short 2>/dev/null || true' ERR

# ---------------------------------------------------------------------------
# STEP 1: Non-agent guard + repo verify
# ---------------------------------------------------------------------------
step "Pre-flight: non-agent guard + repo verify"
if [ -n "${OVERSTORY_AGENT_NAME:-}" ]; then
	err "script must run from non-agent terminal (OVERSTORY_AGENT_NAME='$OVERSTORY_AGENT_NAME')"
fi
[ -d "$SISTER_REPO" ] || err "repo not found: $SISTER_REPO"
[ -d "$SISTER_REPO/.git" ] || err "not a git repo: $SISTER_REPO"
echo "  repo: $SISTER_REPO"
cd "$SISTER_REPO"

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
# STEP 2: Verify remotes
# ---------------------------------------------------------------------------
step "Pre-flight: verify remotes (origin=liker0704/canopy.git, no upstream)"
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || echo "")
echo "$ORIGIN_URL" | grep -qF 'liker0704/canopy' \
	|| err "origin must point to liker0704/canopy; got: $ORIGIN_URL"
if git remote get-url upstream 2>/dev/null; then
	err "upstream remote present; expected none"
fi
echo "  origin: $ORIGIN_URL"
echo "  upstream: not present [OK]"

# ---------------------------------------------------------------------------
# STEP 3: D18 pre-flight — porcelain-extraction (HIGH 3)
# ---------------------------------------------------------------------------
step "Pre-flight: D18 working tree check (awk porcelain-extraction)"
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
echo "  working tree: clean (or agent-defs/ only) [OK]"

# ---------------------------------------------------------------------------
# STEP 4: Baseline quality-gate capture — COMPARE block (MED M2)
# ---------------------------------------------------------------------------
step "Pre-flight: capture baseline quality-gate exit codes (COMPARE)"
set +e
bun test         > /tmp/tane-baseline-test.log 2>&1; BASELINE_TEST_EXIT=$?
bun run lint     > /tmp/tane-baseline-lint.log 2>&1; BASELINE_LINT_EXIT=$?
tsc --noEmit     > /tmp/tane-baseline-tsc.log  2>&1; BASELINE_TSC_EXIT=$?
set -e
echo "  Baseline exits: test=$BASELINE_TEST_EXIT lint=$BASELINE_LINT_EXIT tsc=$BASELINE_TSC_EXIT"
if [ "$BASELINE_TEST_EXIT" -ne 0 ] || [ "$BASELINE_LINT_EXIT" -ne 0 ] || [ "$BASELINE_TSC_EXIT" -ne 0 ]; then
	err "baseline gates RED; refusing to compound (test=$BASELINE_TEST_EXIT lint=$BASELINE_LINT_EXIT tsc=$BASELINE_TSC_EXIT)"
fi

# ---------------------------------------------------------------------------
# STEP 5: Branch
# ---------------------------------------------------------------------------
step "Branch: git checkout -b rebrand-to-tane"
if git show-ref --verify --quiet refs/heads/rebrand-to-tane; then
	echo "  [skip] branch rebrand-to-tane already exists; checking out"
	apply "git checkout rebrand-to-tane"
else
	apply "git checkout -b rebrand-to-tane"
fi

# ---------------------------------------------------------------------------
# STEP 6: Org-qualified pre-pass (HIGH 1) — @os-eco/canopy-cli → @hana/tane-cli
# Must run BEFORE bulk word-boundary pass to prevent corruption.
# ---------------------------------------------------------------------------
step "Pre-pass: rewrite @os-eco/canopy-cli → @hana/tane-cli (before bulk sweep)"
if grep -rqF '@hana/tane-cli' --include="*.ts" --include="*.json" --include="*.md" . 2>/dev/null; then
	echo "  [skip] @hana/tane-cli already present (pre-pass already applied)"
else
	find . -type f \( \
		-name "*.ts" -o -name "*.json" -o -name "*.md" \
		-o -name "*.yaml" -o -name "*.yml" \
		\) \
		-not -path './node_modules/*' -not -path './.git/*' -not -name 'bun.lock' \
		-print0 | xargs -0 grep -lF '@os-eco/canopy-cli' 2>/dev/null \
		| while IFS= read -r f; do
			apply "sed -i 's|@os-eco/canopy-cli|@hana/tane-cli|g' '$f'"
		done
fi

# ---------------------------------------------------------------------------
# STEP 7: Pre-pass integrity checks (positive + negative)
# ---------------------------------------------------------------------------
step "Pre-pass verify: @hana/tane-cli present; @os-eco/tane-cli absent"
if [ "${DRY_RUN:-0}" != "1" ]; then
	if ! grep -rqF '@hana/tane-cli' --include="*.ts" --include="*.json" --include="*.md" . 2>/dev/null; then
		err "org-qualified pre-pass did not introduce @hana/tane-cli"
	fi
	echo "  [✓] positive: @hana/tane-cli is present"
	if grep -rqF '@os-eco/tane-cli' --include="*.ts" --include="*.json" --include="*.md" . 2>/dev/null; then
		err "@os-eco/tane-cli appeared — pre-pass corrupted org name"
	fi
	echo "  [✓] negative: @os-eco/tane-cli is absent (no corruption)"
else
	echo "  [dry-run] skipping grep verification"
fi

# ---------------------------------------------------------------------------
# STEP 8: Explicit — package.json bin key: cn → ta
# (name already rewritten by pre-pass; bin key is cn→ta, not a word-boundary canopy match)
# ---------------------------------------------------------------------------
step "Explicit: package.json bin key (\"cn\" → \"ta\")"
if grep -q '"ta":' package.json 2>/dev/null; then
	echo "  [skip] package.json bin.ta already present"
else
	apply "sed -i 's/\"cn\":/\"ta\":/g' package.json"
fi

# ---------------------------------------------------------------------------
# STEP 9: Explicit — src/index.ts
# .name("cn") → .name("ta")  [the conceptual program.name("cn") call; source
# has program on prior line, .name("cn") chained — see brief acceptance #3]
# palette.brand(chalk.bold("canopy")) → palette.brand(chalk.bold("tane"))
# Usage banner: "Usage: cn " → "Usage: ta "
# ---------------------------------------------------------------------------
step "Explicit: src/index.ts (.name(\"cn\")→\"ta\", palette.brand, usage banner)"
if grep -q '\.name("ta")' src/index.ts 2>/dev/null; then
	echo "  [skip] src/index.ts already rebranded"
else
	apply "sed -i 's/\.name(\"cn\")/\.name(\"ta\")/g' src/index.ts"
	apply "sed -i 's/palette\.brand(chalk\.bold(\"canopy\"))/palette.brand(chalk.bold(\"tane\"))/g' src/index.ts"
	apply "sed -i 's/Usage: cn /Usage: ta /g' src/index.ts"
fi

# ---------------------------------------------------------------------------
# STEP 10: Explicit — src/config.ts project defaults
# ("canopy" word-boundary also covered by bulk pass; explicit step for clarity)
# ---------------------------------------------------------------------------
step "Explicit: src/config.ts project defaults (\"canopy\" → \"tane\")"
if grep -q 'project: "tane"' src/config.ts 2>/dev/null; then
	echo "  [skip] src/config.ts already rebranded"
else
	apply "sed -i 's/project: \"canopy\"/project: \"tane\"/g' src/config.ts"
fi

# ---------------------------------------------------------------------------
# STEP 11: Bulk word-boundary sweep (\bcanopy\b → tane across all text files)
# Excludes: node_modules, .git, bun.lock, LICENSE, .gitattributes (step 14)
# Handles: .canopy/ paths, canopy strings in docs/code, liker0704/canopy URLs
# Note: jayminwest/canopy also matched here — restored in step 12
# ---------------------------------------------------------------------------
step "Bulk: word-boundary sweep \\bcanopy\\b → tane across all text files"
apply "find . -type f \( \
	-name '*.ts' -o -name '*.json' -o -name '*.md' \
	-o -name '*.yaml' -o -name '*.yml' -o -name '*.sh' \
	-o -name '*.txt' -o -name 'CODEOWNERS' \
	\) \
	-not -path './node_modules/*' -not -path './.git/*' \
	-not -name 'bun.lock' -not -name 'LICENSE' -not -name '.gitattributes' \
	-print0 | xargs -0 sed -i \
		-e 's/\bcanopy\b/tane/g' \
		-e 's/\bCanopy\b/Tane/g' \
		-e 's/\bCANOPY\b/TANE/g' \
		2>/dev/null || true"

# ---------------------------------------------------------------------------
# STEP 12: Restore fork-attribution — jayminwest/tane → jayminwest/canopy
# Bulk pass (step 11) also transformed jayminwest/canopy → jayminwest/tane.
# These are preservation sites per brief (fork-attribution stays).
# Also adds README.md attribution line (added after bulk sweep, stays untouched).
# ---------------------------------------------------------------------------
step "Restore: jayminwest/tane → jayminwest/canopy (fork-attribution)"
for f in CLAUDE.md CONTRIBUTING.md README.md SECURITY.md package.json src/commands/onboard.ts; do
	if [ -f "$f" ]; then
		apply "sed -i 's|jayminwest/tane|jayminwest/canopy|g' '$f'"
	fi
done
# Add attribution line to README.md if not already present
if grep -q 'Forked from jayminwest/canopy' README.md 2>/dev/null; then
	echo "  [skip] README.md fork-attribution line already present"
else
	apply "sed -i '1s|^|Forked from jayminwest/canopy under MIT License.\n\n|' README.md"
fi
echo "  [✓] fork-attribution URLs restored in preservation files"

# ---------------------------------------------------------------------------
# STEP 13: Bulk \bcn\b → ta in *.md files
# CLI command shorthand: cn → ta in all documentation (188 sites per baseline)
# ---------------------------------------------------------------------------
step "Bulk: \\bcn\\b → ta in *.md documentation files (CLI shorthand)"
apply "find . -name '*.md' \
	-not -path './node_modules/*' -not -path './.git/*' \
	-print0 | xargs -0 sed -i \
		-e 's/\bcn\b/ta/g' \
		-e 's/\bCN\b/TA/g' \
		2>/dev/null || true"

# ---------------------------------------------------------------------------
# STEP 14: git mv .canopy → .tane + .gitattributes rewrite
# .gitattributes excluded from bulk pass (no extension); handled explicitly.
# ---------------------------------------------------------------------------
step "Attrs: git mv .canopy → .tane + .gitattributes rewrite"
if [ -d .tane ] && [ ! -d .canopy ]; then
	echo "  [skip] .canopy → .tane already renamed"
elif [ -d .canopy ]; then
	apply "git mv .canopy .tane"
elif [ "${DRY_RUN:-0}" = "1" ]; then
	echo "  [dry-run] would git mv .canopy .tane"
else
	err "neither .canopy nor .tane directory present"
fi
# .gitattributes: .canopy/ → .tane/
if grep -q '\.tane/' .gitattributes 2>/dev/null; then
	echo "  [skip] .gitattributes already updated"
else
	apply "sed -i 's/\.canopy\//\.tane\//g' .gitattributes"
fi

# ---------------------------------------------------------------------------
# STEP 15: Docs — CHANGELOG.md Unreleased entry
# ---------------------------------------------------------------------------
step "Docs: CHANGELOG.md add Unreleased entry"
if grep -q '\[Unreleased\] — Renamed to tane' CHANGELOG.md 2>/dev/null; then
	echo "  [skip] CHANGELOG.md Unreleased entry already present"
else
	apply "sed -i '1s|^|## [Unreleased] — Renamed to tane\n\n|' CHANGELOG.md"
fi

# ---------------------------------------------------------------------------
# STEP 16: Finalize — bun install + commit + push + post-mod COMPARE
# ---------------------------------------------------------------------------
step "Finalize: bun install + commit + push + post-mod quality-gate COMPARE"
apply "bun install"
apply "git add -A"
apply "git commit -m 'refactor(rebrand): canopy → tane per mission rebrand-hana-v2'"
safe_push origin rebrand-to-tane

# Post-mod COMPARE (MED M2)
set +e
bun test         > /tmp/tane-post-test.log 2>&1; POST_TEST_EXIT=$?
bun run lint     > /tmp/tane-post-lint.log 2>&1; POST_LINT_EXIT=$?
tsc --noEmit     > /tmp/tane-post-tsc.log  2>&1; POST_TSC_EXIT=$?
set -e

echo "  Post-mod exits: test=$POST_TEST_EXIT lint=$POST_LINT_EXIT tsc=$POST_TSC_EXIT"
if [ "$POST_TEST_EXIT" -gt "$BASELINE_TEST_EXIT" ] || \
	[ "$POST_LINT_EXIT" -gt "$BASELINE_LINT_EXIT" ] || \
	[ "$POST_TSC_EXIT" -gt "$BASELINE_TSC_EXIT" ]; then
	err "post-mod gates REGRESSED: test $BASELINE_TEST_EXIT→$POST_TEST_EXIT, lint $BASELINE_LINT_EXIT→$POST_LINT_EXIT, tsc $BASELINE_TSC_EXIT→$POST_TSC_EXIT"
fi

echo ""
echo "========================================"
echo "  rebrand: canopy → tane  COMPLETE"
echo "========================================"
echo "  Branch     : rebrand-to-tane"
echo "  Sister repo: $SISTER_REPO"
echo "  Baseline   : test=$BASELINE_TEST_EXIT lint=$BASELINE_LINT_EXIT tsc=$BASELINE_TSC_EXIT"
echo "  Post-mod   : test=$POST_TEST_EXIT lint=$POST_LINT_EXIT tsc=$POST_TSC_EXIT"
echo ""
echo "  Operator next step:"
echo "    cd $SISTER_REPO"
echo "    git checkout main && git merge rebrand-to-tane && git push origin main"
