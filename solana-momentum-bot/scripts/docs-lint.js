#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = process.cwd();

const requiredDocs = [
  ['PLAN.md', '> Status: current mission charter'],
  ['STRATEGY.md', '> Status: current quick reference'],
  ['PLAN_CMPL.md', '> Status: completed plan archive'],
  ['docs/exec-plans/active/1sol-to-100sol.md', '> Status: historical execution plan, superseded for day-to-day work'],
  ['docs/exec-plans/active/20260503_BACKLOG.md', '> Status: active backlog'],
  ['README.md', '# Solana Momentum Bot'],
  ['AGENTS.md', '# AGENTS.md — Solana Momentum Bot'],
];

const summaryDocs = ['README.md', 'AGENTS.md'];
const forbiddenActiveReferences = [
  [
    'OPERATIONS.md',
    '현재 active execution 기준 문서는 [`docs/exec-plans/active/1sol-to-100sol.md`',
    'OPERATIONS.md must point active execution to 20260503_BACKLOG.md, not the historical 1sol plan',
  ],
  [
    'SESSION_START.md',
    '백로그: `INCIDENT.md` + `docs/exec-plans/active/1sol-to-100sol.md`',
    'SESSION_START.md must point backlog readers to 20260503_BACKLOG.md',
  ],
  [
    'docs/exec-plans/active/20260503_BACKLOG.md',
    'Authority: `MISSION_CONTROL.md`, `SESSION_START.md`, `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`, `docs/exec-plans/active/1sol-to-100sol.md`',
    '20260503_BACKLOG.md must not list the historical 1sol plan as active authority',
  ],
];

let failures = 0;

function readDoc(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`Missing document: ${relativePath}`);
    failures += 1;
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

for (const [relativePath, expectedText] of requiredDocs) {
  const content = readDoc(relativePath);
  if (content && !content.includes(expectedText)) {
    console.error(`Invalid document header: ${relativePath} -> expected "${expectedText}"`);
    failures += 1;
  }
}

for (const relativePath of summaryDocs) {
  const content = readDoc(relativePath);
  if (!content) continue;
  if (content.includes('archive stub') || content.includes('redirect files')) {
    console.error(`Summary doc should not list deleted archive redirects directly: ${relativePath}`);
    failures += 1;
  }
}

for (const [relativePath, forbiddenText, message] of forbiddenActiveReferences) {
  const content = readDoc(relativePath);
  if (!content) continue;
  if (content.includes(forbiddenText)) {
    console.error(`Forbidden active/historical doc reference: ${relativePath} -> ${message}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`docs-lint failed with ${failures} issue(s)`);
  process.exit(1);
}

console.log('docs-lint passed');
