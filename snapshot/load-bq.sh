#!/usr/bin/env bash
# Replaces every table in a BigQuery dataset with the files written by
# snapshot/export-bq.mjs. Load jobs are free; each table is swapped atomically.
#
#   snapshot/load-bq.sh <project> <dataset> [dir]
set -euo pipefail
project="$1"
dataset="$2"
dir="${3:-bq}"
pids=()
for schema in "$dir"/*.schema.json; do
  table="$(basename "$schema" .schema.json)"
  # Tables load in parallel; each load replaces its table atomically.
  ( bq --project_id="$project" --location=US load --quiet --replace \
      --source_format=NEWLINE_DELIMITED_JSON \
      "$dataset.$table" "$dir/$table.ndjson" "$schema" >/dev/null \
    && echo "loaded $dataset.$table" ) &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
exit "$failed"
