#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = process.cwd();

const requiredDocs = [
  ['PLAN.md', '> Status: current mission charter'],
  ['STRATEGY.md', '> Status: current quick reference'],
  ['PLAN_CMPL.md', '> Status: completed plan archive'],
  ['docs/exec-plans/active/1sol-to-100sol.md', '> Status: current active execution plan'],
  ['README.md', '# Solana Momentum Bot'],
  ['AGENTS.md', '# AGENTS.md — Solana Momentum Bot'],
];

const summaryDocs = ['README.md', 'AGENTS.md'];

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

if (failures > 0) {
  console.error(`docs-lint failed with ${failures} issue(s)`);
  process.exit(1);
}

console.log('docs-lint passed');
