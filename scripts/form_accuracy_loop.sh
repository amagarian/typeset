#!/usr/bin/env bash
set -eo pipefail

interval=300
manifest="eval/forms/manifest.json"
extra_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      interval="${2:-300}"
      shift 2
      ;;
    --manifest)
      manifest="${2:-eval/forms/manifest.json}"
      shift 2
      ;;
    *)
      extra_args+=("$1")
      shift
      ;;
  esac
done

if ! [[ "$interval" =~ ^[0-9]+$ ]] || [[ "$interval" -lt 30 ]]; then
  echo "interval must be an integer number of seconds >= 30" >&2
  exit 2
fi

echo "FORM_EVAL_LOOP_START manifest=${manifest} interval=${interval}s"

while true; do
  started="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "FORM_EVAL_LOOP_RUN_START ${started}"
  if [[ ${#extra_args[@]} -gt 0 ]]; then
    eval_cmd=(python3 scripts/form_accuracy_eval.py --manifest "$manifest" "${extra_args[@]}")
  else
    eval_cmd=(python3 scripts/form_accuracy_eval.py --manifest "$manifest")
  fi
  if "${eval_cmd[@]}"; then
    echo "FORM_EVAL_LOOP_RUN_DONE status=pass"
  else
    code=$?
    echo "FORM_EVAL_LOOP_RUN_DONE status=fail exit_code=${code}"
  fi
  sleep "$interval"
  echo "AGENT_LOOP_TICK_FORM_ACCURACY {\"prompt\":\"Review eval/forms/runs/latest/report.md and all-findings.json, apply the smallest general fix, run typecheck, and rerun impacted PDFs.\"}"
done
