#!/usr/bin/env bash
# Download / refresh the DB-IP "IP to City Lite" and "IP to ASN Lite" databases
# (CC BY 4.0) used for local IP → country/region/city enrichment and for
# spotting data-centre networks. DB-IP publishes a new file monthly;
# run this from a monthly timer. Atomic: the new file is verified, then renamed
# over the old one; the app notices the new mtime within a minute.
#
#   bin/update-geoip.sh [dest-dir]     (default /var/lib/mktperf/geoip)
set -euo pipefail
DEST="${1:-${GEOIP_DIR:-/var/lib/mktperf/geoip}}"
mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# install <db> <min-bytes>: dbip-city-lite (IP → location) and dbip-asn-lite
# (IP → network owner, used to spot data-centre traffic).
install_db() {
  local db="$1" min="$2" name="dbip-$1-lite.mmdb"
  fetch() { curl -fsSL --retry 3 -o "$TMP/$db.gz" "https://download.db-ip.com/free/dbip-$db-lite-$1.mmdb.gz"; }
  # This month's file appears early in the month; fall back to last month's.
  fetch "$(date -u +%Y-%m)" || fetch "$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m 2>/dev/null || date -u -v-1m +%Y-%m)"
  gunzip -c "$TMP/$db.gz" > "$TMP/$name"
  # Sanity: non-trivial size and the MaxMind metadata marker present.
  local size
  size=$(wc -c < "$TMP/$name")
  [ "$size" -gt "$min" ] || { echo "geoip: $name too small ($size bytes)" >&2; return 1; }
  tail -c 200000 "$TMP/$name" | grep -aq 'MaxMind.com' || { echo "geoip: $name is not an mmdb file" >&2; return 1; }
  chmod 644 "$TMP/$name"
  mv -f "$TMP/$name" "$DEST/$name.new"
  mv -f "$DEST/$name.new" "$DEST/$name"
  echo "geoip: installed $DEST/$name ($size bytes)"
}

install_db city 10000000
install_db asn 1000000
