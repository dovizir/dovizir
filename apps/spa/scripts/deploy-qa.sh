#!/usr/bin/env bash
# Deploy the SPA to qa.dovizir.com (Caddy static server on the qa box).
#
# The stale-chunk rules this script exists to enforce (learned 2026-08-29 when
# a deploy broke every open tab):
#
#   1. NEVER delete old hashed assets on deploy. A client holding the previous
#      app shell keeps requesting the previous chunk names; deleting them turns
#      every navigation into "Failed to fetch dynamically imported module".
#      Old assets are pruned only after MAX_AGE_DAYS, long after any session.
#   2. Hashed assets are immutable, the shell revalidates. That split lives in
#      the qa box's /etc/caddy/spa.Caddyfile (Cache-Control: immutable for
#      /assets/*, no-cache for everything else). This script assumes it.
#   3. The build must bake qa's wiring: live-chain RPC from .env, indexer
#      behind the /_indexer proxy.
#
# Usage: apps/spa/scripts/deploy-qa.sh   (from anywhere; needs ssh host "rewo")
set -euo pipefail

HOST="${QA_HOST:-rewo}"
DOCROOT="${QA_DOCROOT:-/var/www/dovizir-spa}"
MAX_AGE_DAYS="${QA_ASSET_MAX_AGE_DAYS:-14}"

cd "$(dirname "$0")/.."

echo "== build (qa wiring: /_indexer) =="
NEXT_PUBLIC_INDEXER_URL=/_indexer npx vite build

echo "== sync (assets first — additive; shell last so it never references missing chunks) =="
rsync -az dist/assets/ "$HOST:$DOCROOT/assets/"
rsync -az --exclude assets/ dist/ "$HOST:$DOCROOT/"

echo "== prune assets older than ${MAX_AGE_DAYS}d =="
ssh "$HOST" "find $DOCROOT/assets -type f -mtime +$MAX_AGE_DAYS -delete"

echo "== verify =="
curl -sfI https://qa.dovizir.com/ | grep -i "cache-control" || {
  echo "WARN: no cache-control on shell — check /etc/caddy/spa.Caddyfile on $HOST" >&2
}
MAIN=$(curl -sf https://qa.dovizir.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -sfI "https://qa.dovizir.com/$MAIN" >/dev/null && echo "OK: shell + $MAIN served"
