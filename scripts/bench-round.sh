#!/usr/bin/env bash
# Run one LongMemEval benchmark round across parallel shards, merge the
# results, and append them to the round history that feeds the progress page.
#
#   scripts/bench-round.sh <round-label> <split> [shards] [-- extra harness args]
#
# Requires pre-sliced shard files (pnpm --filter @synapse/evals shard --split dev).
# Uses the local `claude` CLI for answering+judging: no API key.
set -euo pipefail

LABEL="${1:?usage: bench-round.sh <label> <split> [shards] [-- extra args]}"
SPLIT="${2:-dev}"
SHARDS="${3:-6}"
shift 3 2>/dev/null || shift $#
[ "${1:-}" = "--" ] && shift || true
EXTRA=("$@")

BENCH="$HOME/.synapse/bench"
ROUNDS="$BENCH/rounds"
mkdir -p "$ROUNDS/$LABEL"

export SYNAPSE_LLM_PROVIDER="${SYNAPSE_LLM_PROVIDER:-claude-cli}"
export SYNAPSE_LLM_MODEL="${SYNAPSE_LLM_MODEL:-haiku}"
# Judge is FROZEN at haiku on calibration evidence, not preference. Against 74
# blind-adjudicated items (packages/evals/data/judge-calibration.json): haiku
# 97.8% recall / 100% specificity incl. all 19 manufactured negatives; opus
# 95.6%/100%; sonnet 31.1% recall — it rejects two thirds of correct answers and
# is what made the first two rounds unusable. Do not pass --judge-model sonnet.
JUDGE="${JUDGE:-haiku}"
export SYNAPSE_EMBED_PROVIDER="${SYNAPSE_EMBED_PROVIDER:-local}"
# Each shard parses only its own slice (~14MB), so a modest heap is plenty.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

echo "== round $LABEL | split=$SPLIT | shards=$SHARDS | answerer=$SYNAPSE_LLM_MODEL | judge=$JUDGE"
START=$(date +%s)

pids=()
for i in $(seq 0 $((SHARDS - 1))); do
  (
    pnpm --filter @synapse/evals longmemeval \
      --variant "${SPLIT}${i}" --judge --resume --judge-model "$JUDGE" \
      --out "$ROUNDS/$LABEL/shard${i}.json" ${EXTRA[@]+"${EXTRA[@]}"} \
      >"$ROUNDS/$LABEL/shard${i}.log" 2>&1
  ) &
  pids+=($!)
done

fail=0
for pid in "${pids[@]}"; do wait "$pid" || fail=$((fail + 1)); done
[ "$fail" -gt 0 ] && echo "WARNING: $fail shard(s) exited non-zero (see $ROUNDS/$LABEL/*.log)"

ELAPSED=$(( $(date +%s) - START ))
echo "== shards done in ${ELAPSED}s; merging"

LABEL="$LABEL" SPLIT="$SPLIT" ELAPSED="$ELAPSED" ROUNDS="$ROUNDS" \
  node "$(dirname "$0")/bench-merge.mjs"
