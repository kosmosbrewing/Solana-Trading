#!/bin/bash
# Why: 문서가 코드와 괴리되면 에이전트가 잘못된 컨텍스트로 작업한다
# 사용: bash scripts/check-docs-freshness.sh

set -euo pipefail

FAIL=0

echo "=== AGENTS.md 존재 확인 ==="
if [ ! -f AGENTS.md ]; then
  echo "❌ AGENTS.md 누락"
  FAIL=$((FAIL + 1))
else
  lines=$(wc -l < AGENTS.md)
  if [ "$lines" -gt 100 ]; then
    echo "❌ AGENTS.md가 ${lines}줄 (100줄 초과)"
    FAIL=$((FAIL + 1))
  else
    echo "✅ AGENTS.md 존재 (${lines}줄)"
  fi
fi

echo ""
echo "=== ARCHITECTURE.md 존재 확인 ==="
if [ ! -f ARCHITECTURE.md ]; then
  echo "❌ ARCHITECTURE.md 누락"
  FAIL=$((FAIL + 1))
else
  echo "✅ ARCHITECTURE.md 존재"
fi

echo ""
echo "=== docs/design-docs/index.md 존재 확인 ==="
if [ ! -f docs/design-docs/index.md ]; then
  echo "❌ docs/design-docs/index.md 누락"
  FAIL=$((FAIL + 1))
else
  echo "✅ docs/design-docs/index.md 존재"
fi

echo ""
echo "=== AGENTS.md 내 경로 참조 검증 ==="
# AGENTS.md에서 backtick으로 감싼 경로를 추출하여 존재 확인
grep -oE '`[^`]+\.(md|txt)`' AGENTS.md | tr -d '`' | while read -r docpath; do
  if [ ! -e "$docpath" ]; then
    echo "❌ AGENTS.md에서 참조하는 $docpath 가 존재하지 않음"
    # subshell이므로 FAIL 직접 증가 불가, 표준 에러로 출력
    echo "DOCFAIL" >&2
  fi
done 2>/tmp/doccheck_errors

if [ -s /tmp/doccheck_errors ]; then
  DOCFAILS=$(wc -l < /tmp/doccheck_errors)
  FAIL=$((FAIL + DOCFAILS))
fi
rm -f /tmp/doccheck_errors

echo ""
echo "=== docs/exec-plans/active/ 비어있지 않은지 확인 ==="
if [ -z "$(ls -A docs/exec-plans/active/ 2>/dev/null)" ]; then
  echo "⚠️  활성 실행 계획 없음 (docs/exec-plans/active/ 비어있음)"
else
  echo "✅ 활성 실행 계획 존재"
fi

echo ""
echo "=== 결과 ==="
if [ "$FAIL" -gt 0 ]; then
  echo "❌ 문서 검증 실패 ($FAIL errors)"
  exit 1
fi

echo "✅ 문서 검증 통과"
