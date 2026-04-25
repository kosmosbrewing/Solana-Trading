#!/usr/bin/env ts-node
/**
 * env-catalog (Phase H1.4, 2026-04-25)
 *
 * config.ts 의 모든 `process.env.X` 참조를 single source of truth 로 두고,
 * 자동 generate 된 카탈로그 파일과의 drift 를 검사한다.
 *
 *   `--write`  → `.env.example.generated` 파일 갱신 (canonical reference, do-not-edit)
 *   `--check`  → config.ts 추출 vs 현재 `.env.example.generated` 비교, drift 시 exit 1 (CI gate)
 *   `--print`  → generated 내용을 stdout 으로 (수동 검토용)
 *
 * 정책:
 *  - `.env.example.generated` (auto): 모든 키 — drift CI gate 의 strict 비교 대상
 *  - `.env.example` (curated, hand-maintained): Tier 1+2 starter — info-only, 누락은 warn 만
 *
 * 사용:
 *   npm run env:generate      # .env.example.generated 갱신 후 commit
 *   npm run env:check         # CI — config.ts ↔ generated 일치 확인 (drift 시 fail)
 */
import { readFile } from 'fs/promises';
import path from 'path';
import * as ts from 'typescript';

const CONFIG_PATH = path.resolve(__dirname, '../src/utils/config.ts');
const ENV_EXAMPLE_PATH = path.resolve(__dirname, '../.env.example');
/** Auto-generated canonical reference. drift check 대상. */
const ENV_GENERATED_PATH = path.resolve(__dirname, '../.env.example.generated');

async function extractEnvKeysFromConfig(): Promise<Set<string>> {
  const source = await readFile(CONFIG_PATH, 'utf8');
  const sf = ts.createSourceFile(CONFIG_PATH, source, ts.ScriptTarget.ES2020, true);
  const keys = new Set<string>();

  function visit(node: ts.Node): void {
    // process.env.XYZ
    if (ts.isPropertyAccessExpression(node)) {
      const obj = node.expression;
      if (
        ts.isPropertyAccessExpression(obj) &&
        ts.isIdentifier(obj.expression) &&
        obj.expression.text === 'process' &&
        ts.isIdentifier(obj.name) &&
        obj.name.text === 'env' &&
        ts.isIdentifier(node.name)
      ) {
        keys.add(node.name.text);
      }
    }
    // process.env['XYZ']
    if (ts.isElementAccessExpression(node)) {
      const obj = node.expression;
      if (
        ts.isPropertyAccessExpression(obj) &&
        ts.isIdentifier(obj.expression) &&
        obj.expression.text === 'process' &&
        ts.isIdentifier(obj.name) &&
        obj.name.text === 'env' &&
        ts.isStringLiteral(node.argumentExpression)
      ) {
        keys.add(node.argumentExpression.text);
      }
    }
    // optional('XYZ', ...) / required('XYZ') / boolOptional('XYZ', ...)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fnName = node.expression.text;
      if (['optional', 'required', 'boolOptional'].includes(fnName) && node.arguments[0]) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg)) keys.add(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return keys;
}

async function readExampleKeys(): Promise<Set<string>> {
  try {
    const raw = await readFile(ENV_EXAMPLE_PATH, 'utf8');
    const keys = new Set<string>();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=/);
      if (match) keys.add(match[1]);
    }
    return keys;
  } catch {
    return new Set();
  }
}

function categorize(key: string): string {
  if (key.startsWith('KOL_HUNTER_')) return 'KOL Hunter (Lane T, Phase 3)';
  if (key.startsWith('KOL_')) return 'KOL Discovery (Phase 1)';
  if (key.startsWith('PUREWS_')) return 'pure_ws_breakout (Lane S baseline)';
  if (key.startsWith('CUPSEY_')) return 'cupsey_flip_10s (benchmark, frozen)';
  if (key.startsWith('CANARY_')) return 'Canary guardrails (Real Asset Guard)';
  if (key.startsWith('WALLET_')) return 'Wallet / Real Asset Guard';
  if (key.startsWith('MISSED_ALPHA_')) return 'Missed Alpha Observer';
  if (key.startsWith('JUPITER_429') || key.includes('JUPITER')) return 'Jupiter';
  if (key.startsWith('HELIUS_')) return 'Helius';
  if (key.startsWith('TELEGRAM_') || key.startsWith('NOTIFIER_')) return 'Notifier';
  if (key.startsWith('REALTIME_')) return 'Realtime';
  if (key.startsWith('MIGRATION_')) return 'Migration lane';
  if (key.startsWith('DAILY_BLEED_')) return 'Daily bleed budget';
  if (key.startsWith('PROBE_')) return 'Probe viability';
  if (key.startsWith('QUICK_REJECT_') || key.startsWith('HOLD_PHASE_')) return 'DEX_TRADE Phase 3';
  return 'Other';
}

function buildGeneratedContent(configKeys: Set<string>): string {
  const grouped = new Map<string, string[]>();
  for (const key of [...configKeys].sort()) {
    const cat = categorize(key);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(key);
  }
  const lines: string[] = [];
  lines.push('# .env.example.generated — Auto-generated env catalog');
  lines.push('# DO NOT EDIT — Run `npm run env:generate` to regenerate.');
  lines.push('# Source of truth: src/utils/config.ts');
  lines.push(`# Total keys: ${configKeys.size}`);
  lines.push('');
  lines.push('# Curated starter values: see .env.example (subset, hand-maintained)');
  lines.push('# 이 파일은 카탈로그 (full reference) — value 는 비어있음 (default 는 config.ts 참조)');
  lines.push('');
  for (const [cat, keys] of [...grouped.entries()].sort()) {
    lines.push(`# ─── ${cat} ───`);
    for (const k of keys) lines.push(`${k}=`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const isCheck = process.argv.includes('--check') || (!process.argv.includes('--write') && !process.argv.includes('--print'));
  const isWrite = process.argv.includes('--write');
  const isPrint = process.argv.includes('--print');

  const configKeys = await extractEnvKeysFromConfig();
  const exampleKeys = await readExampleKeys();

  if (isPrint) {
    process.stdout.write(buildGeneratedContent(configKeys));
    return;
  }

  if (isWrite) {
    const { writeFile } = await import('fs/promises');
    const content = buildGeneratedContent(configKeys);
    await writeFile(ENV_GENERATED_PATH, content, 'utf8');
    console.log(`[env-catalog] WRITE — ${ENV_GENERATED_PATH} (${configKeys.size} keys)`);
    return;
  }

  // check mode: config.ts vs .env.example.generated drift
  const expectedContent = buildGeneratedContent(configKeys);
  let currentGenerated = '';
  try {
    currentGenerated = await readFile(ENV_GENERATED_PATH, 'utf8');
  } catch {
    currentGenerated = '';
  }

  // Curated .env.example coverage info (warn only)
  const missingInCurated = [...configKeys].filter((k) => !exampleKeys.has(k));
  const extraInCurated = [...exampleKeys].filter((k) => !configKeys.has(k));

  console.log(`[env-catalog] config.ts keys:        ${configKeys.size}`);
  console.log(`[env-catalog] .env.example (curated): ${exampleKeys.size} (${missingInCurated.length} missing — INFO only)`);
  console.log(`[env-catalog] .env.example.generated: ${currentGenerated ? 'exists' : 'missing'}`);

  if (extraInCurated.length > 0) {
    console.log(`\n[env-catalog] WARN — extra keys in .env.example (config.ts 에 없음):`);
    for (const k of extraInCurated.sort()) console.log(`  ${k}`);
  }

  if (isCheck) {
    if (currentGenerated !== expectedContent) {
      console.log('\n[env-catalog] FAIL — `.env.example.generated` is stale or missing.');
      console.log('  config.ts 의 env 와 generated 파일이 다릅니다.');
      console.log('  `npm run env:generate` 실행 후 commit 하세요.');
      process.exit(1);
    }
    console.log('\n[env-catalog] PASS — generated catalog 정합');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[env-catalog] fatal:', err);
  process.exit(2);
});
