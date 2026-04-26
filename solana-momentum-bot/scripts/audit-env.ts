#!/usr/bin/env ts-node
/**
 * audit-env (2026-04-26): .env vs src/config/* default 비교.
 *
 * 출력: 각 .env key 의 status (DEAD / SAME / OVERRIDE / OVERRIDE_TP / SECRET) +
 *      .env value + code default. SAME 으로 분류된 line 은 제거 후보.
 *
 * 사용:
 *   npx ts-node scripts/audit-env.ts
 *   (CWD = repo root)
 */
import * as fs from 'fs';
import * as path from 'path';

// Parse .env
const envText = fs.readFileSync('.env', 'utf8');
const envMap = new Map<string, string>();
for (const line of envText.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq < 0) continue;
  const key = trimmed.slice(0, eq).trim();
  // Strip trailing comments after value
  let value = trimmed.slice(eq + 1).trim();
  const hashIdx = value.indexOf('#');
  if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
  envMap.set(key, value);
}

// Resolve config to discover actual values + defaults
// Strategy: read each src/config/*.ts file, find every reference to a key, capture the fallback literal.
const configDir = path.resolve('src/config');
const files = fs.readdirSync(configDir).filter((f) => f.endsWith('.ts'));
const codeDefaults = new Map<string, { source: string; defaultValue: string }>();

const patterns: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  // optional('KEY', 'default')
  [/optional\(\s*'([A-Z_0-9]+)'\s*,\s*([^)]*)\)/g, (m) => m[2].trim()],
  // boolOptional('KEY', true|false)
  [/boolOptional\(\s*'([A-Z_0-9]+)'\s*,\s*(true|false)\s*\)/g, (m) => m[2]],
  // numEnv('KEY', '123' or 123)
  [/numEnv\(\s*'([A-Z_0-9]+)'\s*,\s*([^)]*)\)/g, (m) => m[2].trim()],
  // process.env.KEY ?? 'default'
  [/process\.env\.([A-Z_0-9]+)\s*\?\?\s*([^,;)\n]*)/g, (m) => m[2].trim()],
  // process.env.KEY === 'true' (default false)
  [/process\.env\.([A-Z_0-9]+)\s*===\s*'true'/g, () => 'false'],
  // process.env.KEY !== 'false' (default true)
  [/process\.env\.([A-Z_0-9]+)\s*!==\s*'false'/g, () => 'true'],
  // required('KEY')
  [/required\(\s*'([A-Z_0-9]+)'\s*\)/g, () => '<REQUIRED>'],
  // process.env.TRADING_MODE special — parseTradingMode
  [/process\.env\.(TRADING_MODE)\s*\|\|\s*'([a-z]+)'/g, (m) => m[2]],
];

for (const fname of files) {
  const text = fs.readFileSync(path.join(configDir, fname), 'utf8');
  for (const [re, mapper] of patterns) {
    const r = new RegExp(re.source, 'g');
    let match: RegExpMatchArray | null;
    while ((match = r.exec(text)) !== null) {
      const key = match[1];
      const def = mapper(match);
      if (!codeDefaults.has(key)) {
        codeDefaults.set(key, { source: fname, defaultValue: def });
      }
    }
  }
}

// Also scan tradingParams.ts overrides in tradingParamsOverrides.ts (selective spread pattern).
// These are conditional: env presence triggers override, but no fallback default in this file.
// We mark them as "override-only" — code uses tradingParams.ts default.
const tradingParamsText = fs.readFileSync(path.join(configDir, 'tradingParamsOverrides.ts'), 'utf8');
const overrideRe = /process\.env\.([A-Z_0-9]+)/g;
let m: RegExpMatchArray | null;
while ((m = overrideRe.exec(tradingParamsText)) !== null) {
  if (!codeDefaults.has(m[1])) {
    codeDefaults.set(m[1], { source: 'tradingParamsOverrides.ts', defaultValue: '<from tradingParams.ts>' });
  }
}

// Categorize
type Row = { key: string; envValue: string; codeDefault: string; status: string; source: string };
const rows: Row[] = [];

for (const [key, envValue] of envMap) {
  const c = codeDefaults.get(key);
  if (!c) {
    rows.push({ key, envValue, codeDefault: '-', status: 'DEAD', source: '-' });
    continue;
  }
  // Normalize for comparison
  const norm = (v: string) => v.replace(/^['"]|['"]$/g, '').trim();
  const envN = norm(envValue);
  const defN = norm(c.defaultValue);
  if (defN === '<REQUIRED>') {
    rows.push({ key, envValue: envN, codeDefault: 'REQUIRED', status: 'SECRET', source: c.source });
  } else if (defN === '<from tradingParams.ts>') {
    rows.push({ key, envValue: envN, codeDefault: defN, status: 'OVERRIDE_TP', source: c.source });
  } else if (envN === defN) {
    rows.push({ key, envValue: envN, codeDefault: defN, status: 'SAME', source: c.source });
  } else {
    rows.push({ key, envValue: envN, codeDefault: defN, status: 'OVERRIDE', source: c.source });
  }
}

// Print sorted by status
rows.sort((a, b) => {
  const order: Record<string, number> = { DEAD: 0, OVERRIDE: 1, OVERRIDE_TP: 2, SECRET: 3, SAME: 4 };
  return (order[a.status] - order[b.status]) || a.key.localeCompare(b.key);
});

const counts: Record<string, number> = {};
for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;

console.log('Status counts:', counts);
console.log();
console.log('KEY'.padEnd(48), 'STATUS'.padEnd(13), 'ENV_VALUE'.padEnd(28), 'CODE_DEFAULT');
console.log('-'.repeat(130));
for (const r of rows) {
  console.log(
    r.key.padEnd(48),
    r.status.padEnd(13),
    String(r.envValue).slice(0, 27).padEnd(28),
    String(r.codeDefault).slice(0, 40)
  );
}
