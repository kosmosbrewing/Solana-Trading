#!/usr/bin/env bash
# Why: current/historical drift can turn an old live runbook into a capital-risk instruction.
set -euo pipefail

fail=0

require_file() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    echo "[docs-freshness] MISSING: $path" >&2
    fail=$((fail + 1))
  fi
}

require_text() {
  local path="$1"
  local text="$2"
  if [[ -f "$path" ]] && ! grep -Fq "$text" "$path"; then
    echo "[docs-freshness] STALE: $path missing '$text'" >&2
    fail=$((fail + 1))
  fi
}

for path in \
  AGENTS.md \
  ARCHITECTURE.md \
  README.md \
  SESSION_START.md \
  MEMORY.md \
  HYPOTHESES.md \
  20260708.md \
  docs/design-docs/index.md \
  docs/design-docs/mission-refinement-v2-2026-06-10.md; do
  require_file "$path"
done

if [[ -f AGENTS.md ]]; then
  lines=$(wc -l < AGENTS.md | tr -d ' ')
  if [[ "$lines" -gt 100 ]]; then
    echo "[docs-freshness] AGENTS.md is ${lines} lines (>100)" >&2
    fail=$((fail + 1))
  fi
fi

require_text README.md 'RETIRE_CURRENT_LIVE'
require_text SESSION_START.md 'H-007a Is Not Yet Execution-Ready'
require_text HYPOTHESES.md 'PROTOCOL_REQUIRED'
require_text MEMORY.md '### Needs Verification'
require_text docs/design-docs/index.md 'Current allowlist'
require_text docs/design-docs/index.md 'Superseded Operating Paradigms'

# AGENTS.md의 backtick Markdown/text path는 실제 파일이어야 한다.
while IFS= read -r docpath; do
  [[ -z "$docpath" ]] && continue
  if [[ ! -e "$docpath" ]]; then
    echo "[docs-freshness] AGENTS.md broken path: $docpath" >&2
    fail=$((fail + 1))
  fi
done < <(grep -oE '`[^`]+\.(md|txt)`' AGENTS.md | tr -d '`' | sort -u || true)

if [[ "$fail" -ne 0 ]]; then
  echo "[docs-freshness] failed with $fail issue(s)" >&2
  exit 1
fi

echo "[docs-freshness] passed"
