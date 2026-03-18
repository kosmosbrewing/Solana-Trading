#!/bin/bash
# Why: 에이전트가 생성한 코드의 구조적 일탈을 기계적으로 탐지
# 사용: bash scripts/check-structure.sh

set -euo pipefail

FAIL=0
WARN=0

echo "=== 파일 크기 검사 (src/) ==="
while IFS= read -r f; do
  lines=$(wc -l < "$f")
  if [ "$lines" -gt 300 ]; then
    echo "❌ FAIL: $f ($lines lines, 300줄 초과)"
    FAIL=$((FAIL + 1))
  elif [ "$lines" -gt 200 ]; then
    echo "⚠️  WARN: $f ($lines lines, 200줄 초과)"
    WARN=$((WARN + 1))
  fi
done < <(find src/ -name '*.ts' -not -path '*/node_modules/*')

echo ""
echo "=== process.env 직접 접근 검사 ==="
# config.ts와 logger.ts는 예외
VIOLATIONS=$(grep -rn 'process\.env\.' src/ --include='*.ts' \
  | grep -v 'src/utils/config.ts' \
  | grep -v 'src/utils/logger.ts' \
  | grep -v '//.*process\.env' \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "$VIOLATIONS"
  echo "⚠️  process.env 직접 접근 발견 (config.ts를 경유하세요)"
  WARN=$((WARN + $(echo "$VIOLATIONS" | wc -l)))
else
  echo "✅ process.env 직접 접근 없음"
fi

echo ""
echo "=== 결과 ==="
echo "Errors: $FAIL / Warnings: $WARN"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ 구조 검증 실패 ($FAIL errors)"
  exit 1
fi

echo "✅ 구조 검증 통과"
