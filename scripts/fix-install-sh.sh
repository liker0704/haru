#!/bin/bash
# D24: patch /home/liker2/projects/os-eco/install.sh for haru rebrand.
# Run from the os-eco parent directory (where install.sh lives).
# Operator applies this after all workstream branches merge.
#
# What this fixes in install.sh:
#   - clone_if_missing overstory  → clone_if_missing haru
#   - for repo in overstory ...   → for repo in haru ...
#   - OV_DIR=".../overstory"      → OV_DIR=".../haru"
#   - command -v sd               → command -v su
#   - Comment header update

set -euo pipefail

INSTALL_SH="${1:-$(dirname "$0")/../../install.sh}"

if [ ! -f "$INSTALL_SH" ]; then
  echo "ERROR: install.sh not found at $INSTALL_SH"
  echo "Usage: $0 [path-to-install.sh]"
  exit 1
fi

OLD_NAME="overstory"
NEW_NAME="haru"

echo "Patching $INSTALL_SH for ${NEW_NAME} rebrand..."

# 1. clone_if_missing overstory → haru
perl -pi -e "s/^(clone_if_missing )${OLD_NAME}$/\${1}${NEW_NAME}/" "$INSTALL_SH"

# 2. for repo in overstory ... → haru
perl -pi -e "s/\\b${OLD_NAME}\\b/${NEW_NAME}/g" "$INSTALL_SH"

# 3. seeds binary check: command -v sd → command -v su
sed -i 's/command -v sd /command -v su /g' "$INSTALL_SH"

echo "Done. Verify with: grep -n '${OLD_NAME}' $INSTALL_SH | head -5"
