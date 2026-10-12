#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$APP_DIR/static/js/socket.io.min.js"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
URLS=(
  "https://cdn.socket.io/4.7.5/socket.io.min.js"
  "https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.min.js"
  "https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.min.js"
  "https://unpkg.com/socket.io-client@4.7.5/dist/socket.io.min.js"
)
if [ -f "$DEST" ] && [ "$(wc -c < "$DEST")" -gt 25000 ] && grep -aq 'io' "$DEST"; then
  echo "Socket.IO local browser asset already present ($(wc -c < "$DEST") bytes)."
  exit 0
fi
mkdir -p "$(dirname "$DEST")"
for url in "${URLS[@]}"; do
  echo "Trying: $url"
  if curl -fLsS --retry 2 --connect-timeout 12 --max-time 45 "$url" -o "$TMP"; then
    if [ "$(wc -c < "$TMP")" -gt 25000 ] && grep -aq 'io' "$TMP"; then
      mv "$TMP" "$DEST"
      chmod 644 "$DEST"
      echo "SUCCESS: Socket.IO local asset installed ($(wc -c < "$DEST") bytes)."
      exit 0
    fi
  fi
done
echo "ERROR: Socket.IO script could not be downloaded or validated. Deployment must stop here." >&2
exit 1
