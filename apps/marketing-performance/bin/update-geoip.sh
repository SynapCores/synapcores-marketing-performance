#!/usr/bin/env bash
# Download / refresh the DB-IP "IP to City Lite" database (CC BY 4.0) used for
# local IP → country/region/city enrichment. DB-IP publishes a new file monthly;
# run this from a monthly timer. Atomic: the new file is verified, then renamed
# over the old one; the app notices the new mtime within a minute.
#
#   bin/update-geoip.sh [dest-dir]     (default /var/lib/mktperf/geoip)
set -euo pipefail
DEST="${1:-${GEOIP_DIR:-/var/lib/mktperf/geoip}}"
NAME=dbip-city-lite.mmdb
mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { curl -fsSL --retry 3 -o "$TMP/db.gz" "https://download.db-ip.com/free/dbip-city-lite-$1.mmdb.gz"; }
# This month's file appears early in the month; fall back to last month's.
fetch "$(date -u +%Y-%m)" || fetch "$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m 2>/dev/null || date -u -v-1m +%Y-%m)"

gunzip -c "$TMP/db.gz" > "$TMP/$NAME"
# Sanity: non-trivial size and the MaxMind metadata marker present.
SIZE=$(wc -c < "$TMP/$NAME")
[ "$SIZE" -gt 10000000 ] || { echo "geoip: downloaded file too small ($SIZE bytes)" >&2; exit 1; }
tail -c 200000 "$TMP/$NAME" | grep -aq 'MaxMind.com' || { echo "geoip: not an mmdb file" >&2; exit 1; }

chmod 644 "$TMP/$NAME"
mv -f "$TMP/$NAME" "$DEST/$NAME.new"
mv -f "$DEST/$NAME.new" "$DEST/$NAME"
echo "geoip: installed $DEST/$NAME ($SIZE bytes)"
