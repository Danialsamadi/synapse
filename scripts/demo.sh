#!/usr/bin/env bash
# Synapse north-star demo — run with API up: pnpm dev:api
# Step 3 (consolidation) requires a real LLM — set SYNAPSE_LLM_API_KEY.
# Without a key, the demo covers steps 1, 2, 4.
set -euo pipefail
API=${SYNAPSE_URL:-http://localhost:8787}
j() { curl -sS -H 'Content-Type: application/json' "$@"; }

echo "── 1. write memories"
j -X POST "$API/v1/memories" -d '{"type":"semantic","content":"User lives in Vancouver","tags":["location"]}'
j -X POST "$API/v1/memories" -d '{"type":"procedural","content":"Prefer concise bullet answers","tags":["style"],"importance":0.9}'

echo "── 2. retrieve preferences"
j -X POST "$API/v1/memories/retrieve" -d '{"query":"How should you answer me?","limit":3}' | python3 -m json.tool 2>/dev/null || \
  j -X POST "$API/v1/memories/retrieve" -d '{"query":"How should you answer me?","limit":3}'

echo "── 3. contradiction: Toronto → Vancouver (requires SYNAPSE_LLM_API_KEY)"
if [ -n "${SYNAPSE_LLM_API_KEY:-}" ]; then
  j -X POST "$API/v1/memories" -d '{"type":"semantic","content":"User lives in Toronto","tags":["location"]}' >/dev/null
  j -X POST "$API/v1/memories" -d '{"type":"episodic","content":"I moved to Vancouver last month","tags":["location"]}' >/dev/null
  j -X POST "$API/v1/jobs/consolidate" -d '{}'
  echo "   where do I live? →"
  j -X POST "$API/v1/memories/retrieve" -d '{"query":"Where do I live?","limit":3}'
else
  echo "   (skipped — set SYNAPSE_LLM_API_KEY to enable)"
fi

echo "── 4. export + purge"
j "$API/v1/export" | head -c 400; echo " …"
j -X POST "$API/v1/purge" -d '{"tags":["location"]}'
echo "   after purge →"
j -X POST "$API/v1/memories/retrieve" -d '{"query":"Where do I live?","limit":3}'
