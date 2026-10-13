#!/bin/sh
# Full campaign: 3 runs x 3 datasets x 6 options, options interleaved inside
# each run so background load drifts over all of them alike. Nice'd, one
# benchmark at a time.
# Usage: run-all.sh DATASETS_DIR WORK_DIR A_TREE [RUNS]
set -u
here=$(cd "$(dirname "$0")" && pwd)
datasets=$1
work=$2
atree=$3
runs=${4:-"1 2 3"}
mkdir -p "$here/results/raw" "$work"
for run in $runs; do
  for ds in live s50 s200; do
    for opt in A-cli A-proto B C-files C-sqlite D; do
      out="$here/results/raw/$opt-$ds-r$run.json"
      [ -f "$out" ] && continue
      echo "$(date +%H:%M:%S) start $opt $ds r$run"
      timeout 1800 nice -n 19 node "$here/bench.js" --option "$opt" --dataset "$ds" --run "$run" \
        --datasets "$datasets" --work "$work" --a-tree "$atree" --out "$out"
      echo "$(date +%H:%M:%S) end $opt $ds r$run rc=$?"
    done
  done
done
echo "campaign done"
