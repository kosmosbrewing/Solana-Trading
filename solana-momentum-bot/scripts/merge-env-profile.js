#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function readArg(name, fallback) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readLines(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/) : [];
}

function parseAssignments(lines) {
  const assignments = new Map();
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/);
    if (!match) continue;
    assignments.set(match[1], match[2].trimEnd());
  }
  return assignments;
}

function isPlaceholder(value) {
  const clean = value.trim().replace(/^['"]|['"]$/g, '');
  return clean === '' || clean === 'YOUR_KEY' || clean === '<redacted>';
}

const targetPath = path.resolve(process.cwd(), readArg('--target', '.env'));
const profilePath = path.resolve(process.cwd(), readArg('--profile', 'ops/env/production.env'));
const requiredSecrets = (readArg('--required', 'SOLANA_RPC_URL,WALLET_PRIVATE_KEY,DATABASE_URL') || '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);

if (!fs.existsSync(targetPath)) {
  console.error(`[env-profile] ERROR target env not found: ${targetPath}`);
  process.exit(1);
}

if (!fs.existsSync(profilePath)) {
  console.log(`[env-profile] SKIP profile not found: ${profilePath}`);
  process.exit(0);
}

const targetLines = readLines(targetPath);
const profileLines = readLines(profilePath);
const profile = parseAssignments(profileLines);
const knownTypoKeys = new Set(['gOL_HUNTER_LIVE_CANARY_ENABLED']);

if (profile.size === 0) {
  console.error(`[env-profile] ERROR profile has no KEY=value assignments: ${profilePath}`);
  process.exit(1);
}

const seen = new Set();
const mergedLines = targetLines.map((line) => {
  const typoMatch = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=/);
  if (typoMatch && knownTypoKeys.has(typoMatch[1])) return null;

  const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
  if (!match || !profile.has(match[1])) return line;
  seen.add(match[1]);
  return `${match[1]}=${profile.get(match[1])}`;
}).filter((line) => line !== null);

for (const [key, value] of profile.entries()) {
  if (!seen.has(key)) mergedLines.push(`${key}=${value}`);
}

const targetBefore = parseAssignments(targetLines);
const merged = new Map([...targetBefore, ...profile]);
const missingSecrets = requiredSecrets.filter((key) => isPlaceholder(merged.get(key) || ''));

if (missingSecrets.length > 0) {
  console.error(`[env-profile] ERROR required runtime secrets missing after merge: ${missingSecrets.join(', ')}`);
  process.exit(1);
}

fs.copyFileSync(targetPath, `${targetPath}.backup-${Date.now()}`);
fs.writeFileSync(targetPath, `${mergedLines.join('\n').replace(/\n*$/, '')}\n`, { mode: 0o600 });
console.log(`[env-profile] merged ${profile.size} keys from ${path.relative(process.cwd(), profilePath)} into ${path.relative(process.cwd(), targetPath)}`);
