#!/usr/bin/env bash
# Roll the BUSL Change Date to four years from today — the maximum the licence
# allows. Run at EVERY release: BUSL is per-version, so a stale date silently
# shrinks protection on new work, and once the date is in the past, new work is
# published under the Change License the moment it ships.
set -euo pipefail
cd "$(dirname "$0")/.."
NEW=$(date -v+4y +%Y-%m-%d 2>/dev/null || date -d "+4 years" +%Y-%m-%d)
OLD=$(grep -m1 "^Change Date:" LICENSE | awk '{print $3}')
sed -i.bak "s/^Change Date:          .*/Change Date:          ${NEW}/" LICENSE && rm -f LICENSE.bak
echo "Change Date: ${OLD} -> ${NEW}"
echo "Commit LICENSE before tagging the release."
