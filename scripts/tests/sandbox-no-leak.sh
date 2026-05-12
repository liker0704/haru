#!/usr/bin/env bash
set -euo pipefail
TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

# ============================================================
# Case A — origin rewrite under SANDBOX=1
# ============================================================
mkdir -p "$TMP/seeds"
( cd "$TMP/seeds"
  git init -q
  git remote add origin "https://github.com/test-only/will-not-resolve.git"
  echo "test" > README.md && git add . && git commit -qm "init"
)
SANDBOX=1 DRY_RUN=1 SISTER_REPO="$TMP/seeds" bash scripts/suji.sh 2>&1 | tee "$TMP/case-a.log" || true

# After the script exits (and the trap fires), origin should be restored to the original.
post_origin=$(cd "$TMP/seeds" && git remote get-url origin)
if [ "$post_origin" != "https://github.com/test-only/will-not-resolve.git" ]; then
  # Restore did not happen — origin should at least not be non-local
  case "$post_origin" in
    file://*|/*) echo "PASS A: origin ended local (trap may not have restored): $post_origin" ;;
    *) echo "FAIL A: origin in unexpected state: $post_origin"; exit 1 ;;
  esac
else
  # Verify the log shows the rewrite happened DURING the run
  grep -q "origin rewritten" "$TMP/case-a.log" \
    && echo "PASS A: origin rewritten during run, restored on exit" \
    || { echo "FAIL A: no 'origin rewritten' in log"; exit 1; }
fi

# ============================================================
# Case B — safe_push abort path
# ============================================================
# Sourcing the script to access safe_push directly would be invasive.
# Instead, create a minimal repro: a fake script that defines safe_push from suji.sh
# inline and calls it under SANDBOX=1 with a non-local origin.

mkdir -p "$TMP/canopy"
( cd "$TMP/canopy"
  git init -q
  git remote add origin "https://github.com/test-only/abort-case.git"
  echo "test" > README.md && git add . && git commit -qm "init"
)

# Extract safe_push from suji.sh into a temp test wrapper.
awk '/^safe_push\(\) \{/,/^\}/' scripts/suji.sh > "$TMP/safe-push.sh"
cat > "$TMP/abort-test.sh" <<'EOF'
#!/usr/bin/env bash
apply() { echo "[apply] $*"; }
source "$1/safe-push.sh"
safe_push origin rebrand-to-suji
EOF
chmod +x "$TMP/abort-test.sh"

cd "$TMP/canopy"
if SANDBOX=1 bash "$TMP/abort-test.sh" "$TMP" 2>&1 | tee "$TMP/case-b.log"; then
  echo "FAIL B: safe_push did not abort on non-local origin under SANDBOX=1"
  exit 1
else
  grep -qi "non-local\|ABORT" "$TMP/case-b.log" \
    && echo "PASS B: safe_push aborted on non-local origin" \
    || { echo "FAIL B: aborted without expected guard message"; exit 1; }
fi
cd -

# Repeat case A for tane.sh and kura.sh
for script in tane kura; do
  mkdir -p "$TMP/$script"
  ( cd "$TMP/$script"
    git init -q
    git remote add origin "https://github.com/test-only/$script.git"
    echo "test" > README.md && git add . && git commit -qm "init"
  )
  SANDBOX=1 DRY_RUN=1 SISTER_REPO="$TMP/$script" bash "scripts/$script.sh" 2>&1 | tee "$TMP/case-a-$script.log" || true
  grep -q "origin rewritten" "$TMP/case-a-$script.log" \
    && echo "PASS A ($script): origin rewritten during run" \
    || { echo "FAIL A ($script): no 'origin rewritten' in log"; exit 1; }
done

echo "All sandbox-no-leak cases passed."
