#!/usr/bin/env bash
# Look up the current wind signal for a location with curl + jq.
#   BAGYO_API_KEY=bgy_live_... ./examples/lookup.sh Bulacan
set -euo pipefail

API="${BAGYO_API_URL:-http://localhost:3000}"
KEY="${BAGYO_API_KEY:-bgy_live_demo0000000000000000000000000000}"
QUERY="${1:-Batanes}"

curl -sf "$API/v1/signals/lookup?q=$(printf %s "$QUERY" | sed 's/ /%20/g')" \
  -H "Authorization: Bearer $KEY" | jq '{
    location: .data.query.matchedName,
    signal: .data.signal.level,
    partial: .data.signal.partialDescriptor,
    cyclone: .data.signal.context.cyclone.pagasaName,
    source: .source
  }'
