interface JsonRow {
  [key: string]: unknown;
}

interface RotationPaperDigestMetricOptions {
  assumedAtaRentSol: number;
  assumedNetworkFeeSol: number;
}

interface RotationPaperDigestMetrics {
  rows: number;
  comparableRows: number;
  nonComparableRows: number;
  unknownRoleRows: number;
  uniqueCandidates: number;
  uniqueTokens: number;
  refundAdjustedNetSol: number;
  walletStressSol: number;
  tokenWinWalletLoseRows: number;
  topWinnerConcentrationPct: number | null;
}

const COMPARABLE_ROLES = new Set(['mirror', 'fallback_execution_safety']);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): JsonRow {
  return typeof value === 'object' && value != null ? value as JsonRow : {};
}

function paperRoleOf(row: JsonRow): string {
  const extras = obj(row.extras);
  return str(row.paperRole) || str(extras.paperRole);
}

function tokenOnlyNetSol(row: JsonRow): number {
  return num(row.netSolTokenOnly) ?? num(row.tokenOnlyNetSol) ?? num(row.netSol) ?? 0;
}

function walletNetSol(row: JsonRow): number {
  return num(row.netSol) ?? tokenOnlyNetSol(row);
}

function candidateKey(row: JsonRow): string {
  const plan = obj(row.executionPlanSnapshot);
  const extras = obj(row.extras);
  return str(row.liveEquivalenceCandidateId) ||
    str(row.candidateId) ||
    str(plan.candidateId) ||
    str(extras.liveEquivalenceCandidateId) ||
    str(extras.candidateId) ||
    str(row.positionId);
}

function tokenKey(row: JsonRow): string {
  return str(row.tokenMint) || str(row.mint) || str(obj(row.extras).tokenMint);
}

function topWinnerConcentrationPct(rows: JsonRow[], assumedNetworkFeeSol: number): number | null {
  const positiveByToken = new Map<string, number>();
  for (const row of rows) {
    const value = tokenOnlyNetSol(row) - assumedNetworkFeeSol;
    if (value <= 0) continue;
    const key = tokenKey(row) || candidateKey(row);
    if (!key) continue;
    positiveByToken.set(key, (positiveByToken.get(key) ?? 0) + value);
  }
  const values = [...positiveByToken.values()];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || values.length === 0) return null;
  return Math.max(...values) / total;
}

function signedSol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

function pct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function buildRotationPaperDigestMetrics(
  rows: JsonRow[],
  options: RotationPaperDigestMetricOptions
): RotationPaperDigestMetrics {
  const candidates = new Set<string>();
  const tokens = new Set<string>();
  let comparableRows = 0;
  let unknownRoleRows = 0;
  let refundAdjustedNetSol = 0;
  let walletStressSol = 0;
  let tokenWinWalletLoseRows = 0;

  for (const row of rows) {
    const role = paperRoleOf(row);
    if (COMPARABLE_ROLES.has(role)) comparableRows += 1;
    else if (!role) unknownRoleRows += 1;

    const candidate = candidateKey(row);
    if (candidate) candidates.add(candidate);
    const token = tokenKey(row);
    if (token) tokens.add(token);

    const tokenOnly = tokenOnlyNetSol(row);
    refundAdjustedNetSol += tokenOnly - options.assumedNetworkFeeSol;
    walletStressSol += tokenOnly - options.assumedNetworkFeeSol - options.assumedAtaRentSol;
    if (tokenOnly > 0 && walletNetSol(row) < 0) tokenWinWalletLoseRows += 1;
  }

  return {
    rows: rows.length,
    comparableRows,
    nonComparableRows: rows.length - comparableRows,
    unknownRoleRows,
    uniqueCandidates: candidates.size,
    uniqueTokens: tokens.size,
    refundAdjustedNetSol,
    walletStressSol,
    tokenWinWalletLoseRows,
    topWinnerConcentrationPct: topWinnerConcentrationPct(rows, options.assumedNetworkFeeSol),
  };
}

export function renderRotationPaperDigestMetrics(metrics: RotationPaperDigestMetrics): string[] {
  if (metrics.rows === 0) return [];
  const unknownSuffix = metrics.unknownRoleRows > 0 ? ` · unknown role ${metrics.unknownRoleRows}건` : '';
  return [
    `· PAPER role comparable ${metrics.comparableRows}건 / non-comparable ${metrics.nonComparableRows}건${unknownSuffix}`,
    `· unique candidates ${metrics.uniqueCandidates}건 · tokens ${metrics.uniqueTokens}건`,
    `· refund-adjusted ${signedSol(metrics.refundAdjustedNetSol)} SOL · wallet-stress ${signedSol(metrics.walletStressSol)} SOL`,
    `· tokenWinWalletLose ${metrics.tokenWinWalletLoseRows}건 · top winner concentration ${pct(metrics.topWinnerConcentrationPct)}`,
  ];
}
