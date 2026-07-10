#!/usr/bin/env node

// Why: stale live instructions are a capital-risk defect, not cosmetic documentation debt.
const fs = require('fs');
const path = require('path');

const root = process.cwd();
let failures = 0;

function fail(message) {
  console.error(`[docs-lint] ${message}`);
  failures += 1;
}

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`missing: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

const requiredContent = new Map([
  ['../README.md', ['# Solana / Solone', 'RETIRE_CURRENT_LIVE', 'PROTOCOL_REQUIRED', '운영자 결정 대기']],
  ['../AGENTS.md', ['# AGENTS.md — Solana 저장소', 'RETIRE_CURRENT_LIVE', '사전 프로토콜', '자동 배포']],
  ['../harness.md', ['Status: current', 'RETIRE_CURRENT_LIVE', 'solana-momentum-bot/SESSION_START.md', '현재 하네스 gap']],
  ['../agents/ceo/AGENTS.md', ['agents/ceo/HEARTBEAT.md', 'solana-momentum-bot/SESSION_START.md']],
  ['../agents/eventscout/AGENTS.md', ['agents/eventscout/SOUL.md']],
  ['../agents/onchainanalyst/AGENTS.md', ['agents/onchainanalyst/SOUL.md', 'requires an approved protocol']],
  ['README.md', ['# Solana Momentum Bot', 'RETIRE_CURRENT_LIVE', 'PROTOCOL_REQUIRED', 'legacy 직접 접근 15개', 'Needs Verification', 'Runtime vs Approval']],
  ['AGENTS.md', ['# AGENTS.md — Solana Momentum Bot', 'RETIRE_CURRENT_LIVE', 'H-007a', 'src/config/', 'main의 `solana-momentum-bot/**` push']],
  ['SESSION_START.md', ['# SESSION_START — Current Hand-off', 'RETIRE_CURRENT_LIVE', 'PROTOCOL_REQUIRED', 'H-007a Is Not Yet Execution-Ready', 'Needs Verification']],
  ['MEMORY.md', ['## Current Status', '### Blocked', '### Needs Verification', '## Decisions Log', '## Operational Params', '## Known Issues', '## Next Tasks']],
  ['HYPOTHESES.md', ['H-007a', 'PROTOCOL_REQUIRED', 'multiple-testing']],
  ['20260708.md', ['운영자 결정 대기', 'H-007a', '최종 결정']],
  ['PLAN.md', ['Status: historical mission-v1 charter']],
  ['STRATEGY.md', ['Status: implemented runtime inventory / historical operating reference']],
  ['PLAN_CMPL.md', ['Status: completed/historical plan archive']],
  ['docs/design-docs/index.md', ['Status: current index', 'Current allowlist', 'Current Authority Chain', 'Superseded Operating Paradigms']],
  ['docs/design-docs/core-beliefs.md', ['Status: historical pre-pivot belief snapshot']],
  ['docs/design-docs/buy-entry-flow.md', ['Status: historical pre-pivot implementation reference']],
  ['docs/ops-history/README.md', ['Status: historical append-only archive']],
  ['docs/runbooks/live-ops-loop.md', ['Status: historical runbook — suspended']],
]);

for (const [relativePath, expectedValues] of requiredContent.entries()) {
  const content = read(relativePath);
  for (const expected of expectedValues) {
    if (content && !content.includes(expected)) {
      fail(`${relativePath}: expected text not found: ${JSON.stringify(expected)}`);
    }
  }
}

const currentSummaryDocs = [
  '../README.md',
  '../AGENTS.md',
  '../harness.md',
  'README.md',
  'AGENTS.md',
  'SESSION_START.md',
  'MEMORY.md',
  'CLAUDE.md',
];
const forbiddenCurrentClaims = [
  '현 active paradigm',
  'Live canary 활성화 진행',
  '현재 active backlog',
  'current active backlog',
];
for (const relativePath of currentSummaryDocs) {
  const content = read(relativePath);
  for (const forbidden of forbiddenCurrentClaims) {
    if (content.includes(forbidden)) {
      fail(`${relativePath}: stale active claim: ${JSON.stringify(forbidden)}`);
    }
  }
}

const sourceContracts = [
  ['src/config/helpers.ts', "process.env.TRADING_MODE || 'paper'"],
  ['src/config/walletAndCanary.ts', "numEnv('WALLET_STOP_MIN_SOL', '0.6')"],
  ['src/config/walletAndCanary.ts', "numEnv('WALLET_DELTA_DRIFT_HALT_SOL', '0.20')"],
  ['src/config/walletAndCanary.ts', "numEnv('CANARY_GLOBAL_MAX_CONCURRENT', '3')"],
  ['src/utils/policyGuards.ts', 'export const POLICY_TICKET_MAX_SOL = 0.01'],
  ['src/utils/policyGuards.ts', 'kol_hunter: 0.02'],
];
for (const [relativePath, contract] of sourceContracts) {
  const content = read(relativePath);
  if (content && !content.includes(contract)) {
    fail(`${relativePath}: documented safety contract drifted: ${JSON.stringify(contract)}`);
  }
}

const productionProfile = read('ops/env/production.env');
if (productionProfile.includes('TRADING_MODE=live')) {
  for (const relativePath of ['README.md', 'SESSION_START.md', 'MEMORY.md']) {
    const content = read(relativePath);
    if (!content.includes('ops/env/production.env') || !content.includes('live')) {
      fail(`${relativePath}: must disclose tracked live-profile conflict`);
    }
  }
}

function collectTypeScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTypeScriptFiles(absolutePath));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolutePath);
  }
  return files;
}

// env:check는 현재 src/config만 스캔한다. 이 allowlist로 나머지 legacy 직접 접근을
// 가시화하고, 새 카탈로그 누락이 조용히 추가되는 것을 차단한다.
const expectedLegacyDirectEnvKeys = new Set([
  'CUPSEY_TICKET_OVERRIDE_ACK',
  'DEFAULT_AMM_FEE_PCT',
  'DEFAULT_MEV_MARGIN_PCT',
  'HELIUS_CREDIT_LEDGER_IN_TEST',
  'JEST_WORKER_ID',
  'JUPITER_429_MAX_RETRIES',
  'KOL_HOURLY_DIGEST_INTERVAL_MS',
  'KOL_HUNTER_TICKET_OVERRIDE_ACK',
  'LOG_LEVEL',
  'LOG_SILENT',
  'MIGRATION_TICKET_OVERRIDE_ACK',
  'NODE_ENV',
  'PUREWS_SWING_V2_TICKET_OVERRIDE_ACK',
  'PUREWS_TICKET_OVERRIDE_ACK',
  'TRADE_MARKOUT_LEDGER_IN_TEST',
]);
const generatedEnvContent = read('.env.example.generated');
const generatedEnvKeys = new Set(
  [...generatedEnvContent.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
);
const directEnvKeys = new Set();
for (const file of collectTypeScriptFiles(path.join(root, 'src'))) {
  const content = fs.readFileSync(file, 'utf8');
  for (const match of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    directEnvKeys.add(match[1]);
  }
}
const actualLegacyDirectEnvKeys = new Set(
  [...directEnvKeys].filter((key) => !generatedEnvKeys.has(key)),
);
for (const key of actualLegacyDirectEnvKeys) {
  if (!expectedLegacyDirectEnvKeys.has(key)) fail(`unexpected env key outside generated catalog: ${key}`);
}
for (const key of expectedLegacyDirectEnvKeys) {
  if (!actualLegacyDirectEnvKeys.has(key)) fail(`legacy env allowlist is stale; remove or recatalog: ${key}`);
}

const deployWorkflow = read('../.github/workflows/deploy.yml');
if (deployWorkflow.includes('push:') && deployWorkflow.includes("- 'solana-momentum-bot/**'")) {
  for (const relativePath of ['../README.md', '../AGENTS.md', '../harness.md', 'README.md', 'AGENTS.md', 'SESSION_START.md', 'MEMORY.md']) {
    const content = read(relativePath);
    if (!['자동 배포', 'auto-deploy', '자동 VPS deploy', '자동 재시작'].some((text) => content.includes(text))) {
      fail(`${relativePath}: must disclose main bot-path auto-deploy risk`);
    }
  }
}

function validatePackageScriptTargets() {
  const pkg = JSON.parse(read('package.json'));
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    const matches = String(command).matchAll(/\b(?:bash|node|ts-node)\s+([^\s&|;]+)/g);
    for (const match of matches) {
      const target = match[1].replace(/^['"]|['"]$/g, '');
      if (target.startsWith('scripts/') && !fs.existsSync(path.join(root, target))) {
        fail(`package.json script ${name}: missing target ${target}`);
      }
    }
  }
}

function normalizeLinkTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(target)) return null;
  if (target.startsWith('#') || target.startsWith('/')) return null;
  target = target.split('#')[0].split('?')[0];
  if (!target || /[{}*]/.test(target)) return null;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function validateRelativeMarkdownLinks(relativePath) {
  const content = read(relativePath);
  const linkPattern = /!?(?:\[[^\]]*\])\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const target = normalizeLinkTarget(match[1]);
    if (!target) continue;
    const absoluteTarget = path.resolve(root, path.dirname(relativePath), target);
    if (!fs.existsSync(absoluteTarget)) {
      fail(`${relativePath}: broken relative link -> ${match[1]}`);
    }
  }
}

const currentLinkDocs = [
  '../README.md',
  '../AGENTS.md',
  '../harness.md',
  '../HARNESS_REFACTORING.md',
  '../agents/ceo/AGENTS.md',
  '../agents/ceo/HEARTBEAT.md',
  '../agents/eventscout/AGENTS.md',
  '../agents/onchainanalyst/AGENTS.md',
  'README.md',
  'AGENTS.md',
  'SESSION_START.md',
  'MEMORY.md',
  'CLAUDE.md',
  'MISSION_CONTROL.md',
  'PLAN.md',
  'PROJECT.md',
  'STRATEGY.md',
  'OPERATIONS.md',
  'MEASUREMENT.md',
  'ARCHITECTURE.md',
  'docs/design-docs/index.md',
  'docs/INCIDENT_SUMMARY.md',
];
for (const relativePath of currentLinkDocs) validateRelativeMarkdownLinks(relativePath);

validatePackageScriptTargets();

if (failures > 0) {
  console.error(`[docs-lint] failed with ${failures} issue(s)`);
  process.exit(1);
}

console.log(`[docs-lint] passed (${currentLinkDocs.length} current docs link-checked)`);
