#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="$ROOT_DIR/data/realtime/sessions"
RESULTS_DIR="$ROOT_DIR/results"
TRIGGER_TYPE="bootstrap"
INPUT_MODE="swaps"
VOLUME_MULTIPLIER="1.8"
MIN_BUY_RATIO="0.55"
VOLUME_LOOKBACK="20"
COOLDOWN_SEC="300"
HORIZON_SEC="30"
ESTIMATED_COST_PCT="0"
GATE_MODE="off"
NOTIONAL_SOL="0.1"
SAVE_BASENAME=""
VM_LIST=""
BUY_RATIO_LIST=""
LOOKBACK_LIST=""

usage() {
  cat <<'EOF'
Usage:
  scripts/bootstrap-replay-report.sh [options]

Options:
  --data-root <dir>              Session root directory
  --volume-multiplier <n>        Bootstrap volume multiplier (default: 1.8)
  --min-buy-ratio <n>            Bootstrap min buy ratio (default: 0.55)
  --volume-lookback <n>          Bootstrap volume lookback (default: 20)
  --cooldown-sec <n>             Bootstrap cooldown seconds (default: 300)
  --horizon <sec>                Summary horizon in seconds (default: 30)
  --estimated-cost-pct <n>       Cost haircut (default: 0)
  --gate-mode <off|stored>       Gate replay mode (default: off)
  --notional-sol <n>             Fixed SOL notional per signal (default: 0.1)
  --vm-list <csv>                Sweep volume multipliers (e.g. 1.8,2.2,2.5)
  --buy-ratio-list <csv>         Sweep min buy ratios (e.g. 0.55,0.60)
  --lookback-list <csv>          Sweep lookbacks (e.g. 20,30)
  --save [basename]              Save markdown/json report to results/
  --help                         Show help

Examples:
  scripts/bootstrap-replay-report.sh
  scripts/bootstrap-replay-report.sh --estimated-cost-pct 0.003
  scripts/bootstrap-replay-report.sh --estimated-cost-pct 0.003 --gate-mode stored
  scripts/bootstrap-replay-report.sh --notional-sol 0.1 --save bootstrap-detail
  scripts/bootstrap-replay-report.sh --vm-list 1.8,2.2,2.5 --buy-ratio-list 0.55,0.60 --lookback-list 20,30 --save bootstrap-sweep
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-root) DATA_ROOT="$2"; shift 2 ;;
    --volume-multiplier) VOLUME_MULTIPLIER="$2"; shift 2 ;;
    --min-buy-ratio) MIN_BUY_RATIO="$2"; shift 2 ;;
    --volume-lookback) VOLUME_LOOKBACK="$2"; shift 2 ;;
    --cooldown-sec) COOLDOWN_SEC="$2"; shift 2 ;;
    --horizon) HORIZON_SEC="$2"; shift 2 ;;
    --estimated-cost-pct) ESTIMATED_COST_PCT="$2"; shift 2 ;;
    --gate-mode) GATE_MODE="$2"; shift 2 ;;
    --notional-sol) NOTIONAL_SOL="$2"; shift 2 ;;
    --vm-list) VM_LIST="$2"; shift 2 ;;
    --buy-ratio-list) BUY_RATIO_LIST="$2"; shift 2 ;;
    --lookback-list) LOOKBACK_LIST="$2"; shift 2 ;;
    --save)
      if [[ $# -ge 2 && "$2" != --* ]]; then
        SAVE_BASENAME="$2"
        shift 2
      else
        SAVE_BASENAME="bootstrap-replay-$(date -u +%Y%m%dT%H%M%SZ)"
        shift 1
      fi
      ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ ! -d "$DATA_ROOT" ]]; then
  echo "Session root not found: $DATA_ROOT" >&2
  exit 1
fi

SESSIONS=(
  "2026-03-31T15-15-34-690Z-live|Mar 31"
  "2026-04-02T03-18-12-410Z-live|Apr 2 AM"
  "2026-04-02T13-29-31-708Z-live|Apr 2 PM"
  "2026-04-03T03-53-57-260Z-live|Apr 3 AM"
  "2026-04-03T15-45-41-044Z-live|Apr 3 PM"
)

csv_to_array() {
  local raw="$1"
  if [[ -z "$raw" ]]; then
    return
  fi
  local item
  IFS=',' read -r -a CSV_PARTS <<< "$raw"
  for item in "${CSV_PARTS[@]}"; do
    item="${item// /}"
    [[ -n "$item" ]] && printf '%s\n' "$item"
  done
}

VM_VALUES=()
BUY_RATIO_VALUES=()
LOOKBACK_VALUES=()
while IFS= read -r item; do VM_VALUES+=("$item"); done < <(csv_to_array "$VM_LIST")
while IFS= read -r item; do BUY_RATIO_VALUES+=("$item"); done < <(csv_to_array "$BUY_RATIO_LIST")
while IFS= read -r item; do LOOKBACK_VALUES+=("$item"); done < <(csv_to_array "$LOOKBACK_LIST")

if [[ ${#VM_VALUES[@]} -eq 0 ]]; then
  VM_VALUES=("$VOLUME_MULTIPLIER")
fi
if [[ ${#BUY_RATIO_VALUES[@]} -eq 0 ]]; then
  BUY_RATIO_VALUES=("$MIN_BUY_RATIO")
fi
if [[ ${#LOOKBACK_VALUES[@]} -eq 0 ]]; then
  LOOKBACK_VALUES=("$VOLUME_LOOKBACK")
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PROFILE_IDS=()

for vm in "${VM_VALUES[@]}"; do
  for buy_ratio in "${BUY_RATIO_VALUES[@]}"; do
    for lookback in "${LOOKBACK_VALUES[@]}"; do
      profile_id="vm${vm}-br${buy_ratio}-lb${lookback}"
      PROFILE_IDS+=("$profile_id")
      mkdir -p "$TMP_DIR/$profile_id"

      for entry in "${SESSIONS[@]}"; do
        session="${entry%%|*}"
        out="$TMP_DIR/$profile_id/$session.json"

        cmd=(
          npx ts-node scripts/micro-backtest.ts
          --trigger-type "$TRIGGER_TYPE"
          --input-mode "$INPUT_MODE"
          --volume-multiplier "$vm"
          --min-buy-ratio "$buy_ratio"
          --volume-lookback "$lookback"
          --cooldown-sec "$COOLDOWN_SEC"
          --horizon "$HORIZON_SEC"
          --estimated-cost-pct "$ESTIMATED_COST_PCT"
          --gate-mode "$GATE_MODE"
          --dataset "$DATA_ROOT/$session"
          --json
        )
        if [[ -n "$SAVE_BASENAME" ]]; then
          cmd+=(--include-records)
        fi

        raw="$("${cmd[@]}")"
        RAW_OUTPUT="$raw" node - <<'NODE' > "$out"
const raw = process.env.RAW_OUTPUT ?? '';
const idx = raw.indexOf('{');
if (idx < 0) {
  throw new Error('JSON output not found in micro-backtest stdout');
}
const parsed = JSON.parse(raw.slice(idx));
process.stdout.write(JSON.stringify(parsed, null, 2));
NODE
      done
    done
  done
done

TMP_DIR="$TMP_DIR" \
RESULTS_DIR="$RESULTS_DIR" \
COOLDOWN_SEC="$COOLDOWN_SEC" \
HORIZON_SEC="$HORIZON_SEC" \
ESTIMATED_COST_PCT="$ESTIMATED_COST_PCT" \
GATE_MODE="$GATE_MODE" \
NOTIONAL_SOL="$NOTIONAL_SOL" \
SAVE_BASENAME="$SAVE_BASENAME" \
PROFILE_IDS="$(IFS=,; echo "${PROFILE_IDS[*]}")" \
node - <<'NODE'
const fs = require('fs');
const path = require('path');

const sessions = [
  { id: '2026-03-31T15-15-34-690Z-live', label: 'Mar 31' },
  { id: '2026-04-02T03-18-12-410Z-live', label: 'Apr 2 AM' },
  { id: '2026-04-02T13-29-31-708Z-live', label: 'Apr 2 PM' },
  { id: '2026-04-03T03-53-57-260Z-live', label: 'Apr 3 AM' },
  { id: '2026-04-03T15-45-41-044Z-live', label: 'Apr 3 PM' },
];

const tmpDir = process.env.TMP_DIR;
const profileIds = (process.env.PROFILE_IDS || '').split(',').filter(Boolean);
const isSweep = profileIds.length > 1;
const notionalSol = Number(process.env.NOTIONAL_SOL || '0.1');

const pad = (value, width, align = 'left') => {
  const text = String(value);
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
};
const pct = (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(3)}%`;
const sol = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(4)} SOL`;
const lines = [];
const push = (line = '') => {
  lines.push(line);
  console.log(line);
};

function parseProfile(profileId) {
  const match = /^vm(.+)-br(.+)-lb(.+)$/.exec(profileId);
  if (!match) {
    return { id: profileId, volumeMultiplier: NaN, minBuyRatio: NaN, volumeLookback: NaN };
  }
  return {
    id: profileId,
    volumeMultiplier: Number(match[1]),
    minBuyRatio: Number(match[2]),
    volumeLookback: Number(match[3]),
  };
}

function loadProfile(profileId) {
  const meta = parseProfile(profileId);
  const rows = sessions.map((session) => {
    const file = path.join(tmpDir, profileId, `${session.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      label: session.label,
      session: session.id,
      signals: parsed.summary.totalSignals,
      executed: parsed.summary.executedSignals,
      gateRejected: parsed.summary.gateRejectedSignals,
      avgReturnPct: parsed.summary.avgReturnPct,
      avgAdjustedReturnPct: parsed.summary.avgAdjustedReturnPct,
      edgeScore: parsed.summary.edgeScore,
      decision: parsed.summary.stageDecision,
    };
  });

  const weightedSignals = rows.reduce((sum, row) => sum + row.signals, 0);
  const weightedAvgReturnPct = weightedSignals > 0
    ? rows.reduce((sum, row) => sum + row.avgReturnPct * row.signals, 0) / weightedSignals
    : 0;
  const weightedAvgAdjustedReturnPct = weightedSignals > 0
    ? rows.reduce((sum, row) => sum + row.avgAdjustedReturnPct * row.signals, 0) / weightedSignals
    : 0;
  const avgEdge = rows.reduce((sum, row) => sum + row.edgeScore, 0) / rows.length;
  const keepCount = rows.filter((row) => row.decision === 'keep').length;
  const estimatedTotalPnlSol = rows.reduce(
    (sum, row) => sum + row.avgAdjustedReturnPct * row.signals * notionalSol,
    0
  );

  return {
    profileId,
    ...meta,
    rows,
    aggregate: {
      weightedSignals,
      weightedAvgReturnPct,
      weightedAvgAdjustedReturnPct,
      avgEdge,
      keepCount,
      estimatedTotalPnlSol,
    },
  };
}

const profiles = profileIds.map(loadProfile);

function printProfileTable(profile) {
  push(`Bootstrap Replay Report${isSweep ? ` — ${profile.profileId}` : ''}`);
  push(
    `  trigger=bootstrap vm=${profile.volumeMultiplier} lookback=${profile.volumeLookback} ` +
    `buyRatio=${profile.minBuyRatio} cooldown=${process.env.COOLDOWN_SEC}s`
  );
  push(`  horizon=${process.env.HORIZON_SEC}s cost=${process.env.ESTIMATED_COST_PCT} gate=${process.env.GATE_MODE}`);
  push(`  fixed notional per signal=${notionalSol} SOL`);
  push('');
  push('┌──────────┬─────────┬───────────┬───────────┬────────────┬──────┬──────────┐');
  push('│ Session  │ Signals │ avgReturn │ adjReturn │ estPnL SOL │ Edge │ Decision │');
  push('├──────────┼─────────┼───────────┼───────────┼────────────┼──────┼──────────┤');
  for (const row of profile.rows) {
    const estimatedPnlSol = row.avgAdjustedReturnPct * row.signals * notionalSol;
    push(
      `│ ${pad(row.label, 8)} │ ${pad(row.signals, 7, 'right')} │ ${pad(pct(row.avgReturnPct), 9, 'right')} │ ${pad(pct(row.avgAdjustedReturnPct), 9, 'right')} │ ${pad(sol(estimatedPnlSol), 10, 'right')} │ ${pad(row.edgeScore, 4, 'right')} │ ${pad(row.decision, 8)} │`
    );
  }
  push('└──────────┴─────────┴───────────┴───────────┴────────────┴──────┴──────────┘');
  push('');
  push(`Weighted signals: ${profile.aggregate.weightedSignals}`);
  push(`Weighted avgReturn: ${pct(profile.aggregate.weightedAvgReturnPct)}`);
  push(`Weighted adjReturn: ${pct(profile.aggregate.weightedAvgAdjustedReturnPct)}`);
  push(`Estimated total PnL: ${sol(profile.aggregate.estimatedTotalPnlSol)}`);
  push('');
  for (const row of profile.rows) {
    push(
      `${row.label}: session=${row.session} signals=${row.signals} executed=${row.executed} gateRejected=${row.gateRejected}`
    );
  }
}

if (isSweep) {
  const ranked = [...profiles].sort((a, b) => {
    if (b.aggregate.weightedAvgAdjustedReturnPct !== a.aggregate.weightedAvgAdjustedReturnPct) {
      return b.aggregate.weightedAvgAdjustedReturnPct - a.aggregate.weightedAvgAdjustedReturnPct;
    }
    if (b.aggregate.avgEdge !== a.aggregate.avgEdge) {
      return b.aggregate.avgEdge - a.aggregate.avgEdge;
    }
    return b.aggregate.weightedSignals - a.aggregate.weightedSignals;
  });

  push('Bootstrap Replay Sweep');
  push(`  horizon=${process.env.HORIZON_SEC}s cost=${process.env.ESTIMATED_COST_PCT} gate=${process.env.GATE_MODE}`);
  push(`  fixed notional per signal=${notionalSol} SOL`);
  push('');
  push('┌────────────────────┬─────────┬───────────┬───────────┬────────────┬─────────┬──────┐');
  push('│ Profile            │ Signals │ avgReturn │ adjReturn │ estPnL SOL │ keep/5  │ Edge │');
  push('├────────────────────┼─────────┼───────────┼───────────┼────────────┼─────────┼──────┤');
  for (const profile of ranked) {
    push(
      `│ ${pad(profile.profileId, 18)} │ ${pad(profile.aggregate.weightedSignals, 7, 'right')} │ ${pad(pct(profile.aggregate.weightedAvgReturnPct), 9, 'right')} │ ${pad(pct(profile.aggregate.weightedAvgAdjustedReturnPct), 9, 'right')} │ ${pad(sol(profile.aggregate.estimatedTotalPnlSol), 10, 'right')} │ ${pad(`${profile.aggregate.keepCount}/5`, 7, 'right')} │ ${pad(profile.aggregate.avgEdge.toFixed(1), 4, 'right')} │`
    );
  }
  push('└────────────────────┴─────────┴───────────┴───────────┴────────────┴─────────┴──────┘');
  push('');
  printProfileTable(ranked[0]);
} else {
  printProfileTable(profiles[0]);
}

const basename = process.env.SAVE_BASENAME;
if (basename) {
  const resultsDir = process.env.RESULTS_DIR;
  fs.mkdirSync(resultsDir, { recursive: true });
  const markdownPath = path.join(resultsDir, `${basename}.md`);
  const jsonPath = path.join(resultsDir, `${basename}.json`);
  const detailJsonPath = path.join(resultsDir, `${basename}.details.json`);
  const detailCsvPath = path.join(resultsDir, `${basename}.details.csv`);

  const markdownChunks = profiles.map((profile) => {
    const table = [
      '| Session | Signals | avgReturn | adjReturn | estPnL SOL | Edge | Decision |',
      '|---|---:|---:|---:|---:|---:|---|',
      ...profile.rows.map((row) =>
        `| ${row.label} | ${row.signals} | ${pct(row.avgReturnPct)} | ${pct(row.avgAdjustedReturnPct)} | ${sol(row.avgAdjustedReturnPct * row.signals * notionalSol)} | ${row.edgeScore} | ${row.decision} |`
      ),
    ].join('\n');

    return [
      `## ${profile.profileId}`,
      '',
      `- vm=${profile.volumeMultiplier}`,
      `- lookback=${profile.volumeLookback}`,
      `- minBuyRatio=${profile.minBuyRatio}`,
      '',
      table,
      '',
      `- Weighted signals: ${profile.aggregate.weightedSignals}`,
      `- Weighted avgReturn: ${pct(profile.aggregate.weightedAvgReturnPct)}`,
      `- Weighted adjReturn: ${pct(profile.aggregate.weightedAvgAdjustedReturnPct)}`,
      `- Estimated total PnL (${notionalSol} SOL/signal): ${sol(profile.aggregate.estimatedTotalPnlSol)}`,
      `- Average edge: ${profile.aggregate.avgEdge.toFixed(1)}`,
      '',
    ].join('\n');
  });

  const leaderboard = isSweep
    ? [
        '## Leaderboard',
        '',
        `- Fixed notional per signal: ${notionalSol} SOL`,
        '',
        '| Profile | Signals | avgReturn | adjReturn | estPnL SOL | keep/5 | Avg Edge |',
        '|---|---:|---:|---:|---:|---:|---:|',
        ...profiles
          .slice()
          .sort((a, b) => b.aggregate.weightedAvgAdjustedReturnPct - a.aggregate.weightedAvgAdjustedReturnPct)
          .map((profile) =>
            `| ${profile.profileId} | ${profile.aggregate.weightedSignals} | ${pct(profile.aggregate.weightedAvgReturnPct)} | ${pct(profile.aggregate.weightedAvgAdjustedReturnPct)} | ${sol(profile.aggregate.estimatedTotalPnlSol)} | ${profile.aggregate.keepCount}/5 | ${profile.aggregate.avgEdge.toFixed(1)} |`
          ),
        '',
      ].join('\n')
    : '';

  const markdown = [
    '# Bootstrap Replay Report',
    '',
    `- trigger=bootstrap`,
    `- cooldown=${process.env.COOLDOWN_SEC}s`,
    `- horizon=${process.env.HORIZON_SEC}s`,
    `- estimatedCostPct=${process.env.ESTIMATED_COST_PCT}`,
    `- gateMode=${process.env.GATE_MODE}`,
    `- fixedNotionalSol=${notionalSol}`,
    '',
    leaderboard,
    ...markdownChunks,
  ].join('\n');

  const detailProfiles = profiles.map((profile) => {
    const sessionDetails = sessions.map((session) => {
      const file = path.join(tmpDir, profile.profileId, `${session.id}.json`);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      const detailRows = records.map((record) => {
        const selected = (record.horizons || []).find(
          (item) => item.horizonSec === Number(process.env.HORIZON_SEC)
        ) || (record.horizons || [])[0];
        const estimatedPnlSol = Number(selected?.adjustedReturnPct || 0) * notionalSol;
        return {
          session: session.id,
          sessionLabel: session.label,
          profileId: profile.profileId,
          strategy: record.strategy,
          pairAddress: record.pairAddress,
          poolAddress: record.poolAddress,
          tokenMint: record.tokenMint,
          tokenSymbol: record.tokenSymbol,
          signalTimestamp: record.signalTimestamp,
          processingStatus: record.processing?.status,
          filterReason: record.processing?.filterReason || record.gate?.filterReason || '',
          referencePrice: record.referencePrice,
          observedPrice: selected?.price ?? null,
          returnPct: selected?.returnPct ?? null,
          adjustedReturnPct: selected?.adjustedReturnPct ?? null,
          estimatedPnlSol,
          mfePct: selected?.mfePct ?? null,
          maePct: selected?.maePct ?? null,
          volumeRatio: record.trigger?.volumeRatio,
          buyRatio: record.trigger?.buyRatio,
          breakoutScore: record.trigger?.breakoutScore,
          breakoutGrade: record.trigger?.breakoutGrade,
        };
      });

      const tokenSummaryMap = new Map();
      for (const row of detailRows) {
        const key = row.tokenMint || row.pairAddress;
        const current = tokenSummaryMap.get(key) || {
          tokenMint: row.tokenMint || '',
          tokenSymbol: row.tokenSymbol || '',
          pairAddress: row.pairAddress,
          signals: 0,
          executed: 0,
          gateRejected: 0,
          avgReturnPct: 0,
          avgAdjustedReturnPct: 0,
          totalReturnPct: 0,
          totalAdjustedReturnPct: 0,
          totalEstimatedPnlSol: 0,
        };
        current.signals += 1;
        if (row.processingStatus === 'executed_paper' || row.processingStatus === 'executed_live') {
          current.executed += 1;
        }
        if (row.processingStatus === 'gate_rejected') {
          current.gateRejected += 1;
        }
        current.totalReturnPct += Number(row.returnPct || 0);
        current.totalAdjustedReturnPct += Number(row.adjustedReturnPct || 0);
        current.totalEstimatedPnlSol += Number(row.estimatedPnlSol || 0);
        tokenSummaryMap.set(key, current);
      }

      const tokenSummaries = Array.from(tokenSummaryMap.values())
        .map((item) => ({
          ...item,
          avgReturnPct: item.signals > 0 ? item.totalReturnPct / item.signals : 0,
          avgAdjustedReturnPct: item.signals > 0 ? item.totalAdjustedReturnPct / item.signals : 0,
          avgEstimatedPnlSol: item.signals > 0 ? item.totalEstimatedPnlSol / item.signals : 0,
        }))
        .sort((left, right) => right.totalEstimatedPnlSol - left.totalEstimatedPnlSol);

      return {
        session: session.id,
        sessionLabel: session.label,
        summary: profile.rows.find((row) => row.session === session.id),
        tokenSummaries,
        signals: detailRows,
      };
    });

    return {
      profileId: profile.profileId,
      volumeMultiplier: profile.volumeMultiplier,
      minBuyRatio: profile.minBuyRatio,
      volumeLookback: profile.volumeLookback,
      aggregate: profile.aggregate,
      sessions: sessionDetails,
    };
  });

  const flatCsvRows = [
    [
      'profileId',
      'sessionLabel',
      'session',
      'tokenSymbol',
      'tokenMint',
      'pairAddress',
      'poolAddress',
      'signalTimestamp',
      'processingStatus',
      'filterReason',
      'referencePrice',
      'observedPrice',
      'returnPct',
      'adjustedReturnPct',
      'estimatedPnlSol',
      'mfePct',
      'maePct',
      'volumeRatio',
      'buyRatio',
      'breakoutScore',
      'breakoutGrade',
    ].join(','),
  ];

  for (const profile of detailProfiles) {
    for (const session of profile.sessions) {
      for (const row of session.signals) {
        const csvFields = [
          row.profileId,
          row.sessionLabel,
          row.session,
          row.tokenSymbol || '',
          row.tokenMint || '',
          row.pairAddress || '',
          row.poolAddress || '',
          row.signalTimestamp || '',
          row.processingStatus || '',
          row.filterReason || '',
          row.referencePrice ?? '',
          row.observedPrice ?? '',
          row.returnPct ?? '',
          row.adjustedReturnPct ?? '',
          row.estimatedPnlSol ?? '',
          row.mfePct ?? '',
          row.maePct ?? '',
          row.volumeRatio ?? '',
          row.buyRatio ?? '',
          row.breakoutScore ?? '',
          row.breakoutGrade || '',
        ].map((value) => `"${String(value).replace(/"/g, '""')}"`);
        flatCsvRows.push(csvFields.join(','));
      }
    }
  }

  fs.writeFileSync(markdownPath, `${markdown.trim()}\n`, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: {
      trigger: 'bootstrap',
      cooldownSec: Number(process.env.COOLDOWN_SEC),
      horizonSec: Number(process.env.HORIZON_SEC),
      estimatedCostPct: Number(process.env.ESTIMATED_COST_PCT),
      gateMode: process.env.GATE_MODE,
      fixedNotionalSol: notionalSol,
    },
    profiles,
  }, null, 2), 'utf8');
  fs.writeFileSync(detailJsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: {
      trigger: 'bootstrap',
      cooldownSec: Number(process.env.COOLDOWN_SEC),
      horizonSec: Number(process.env.HORIZON_SEC),
      estimatedCostPct: Number(process.env.ESTIMATED_COST_PCT),
      gateMode: process.env.GATE_MODE,
      fixedNotionalSol: notionalSol,
    },
    profiles: detailProfiles,
  }, null, 2), 'utf8');
  fs.writeFileSync(detailCsvPath, `${flatCsvRows.join('\n')}\n`, 'utf8');

  push('');
  push(`Saved: ${markdownPath}`);
  push(`Saved: ${jsonPath}`);
  push(`Saved: ${detailJsonPath}`);
  push(`Saved: ${detailCsvPath}`);
}
NODE
