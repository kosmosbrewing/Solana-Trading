/**
 * quarantine-synthetic-markout-rows (2026-06-10 edge audit)
 *
 * Why: jest test isolation 결함으로 production markout ledger 에 synthetic row
 * (tokenMint "PAIR7", "PAIR_SURVIVAL_MISSING_ALLOW" 등 비-base58) 가 append 됐다.
 * 관측 원장은 사후 수정하지 않는 것이 원칙이므로 직접 삭제 대신:
 *   (1) timestamped .bak 백업 →
 *   (2) base58 mint 가 아닌 row 를 quarantine sidecar 로 이동 →
 *   (3) 원본은 정상 row 만 남겨 atomic 재작성 (tmp + rename).
 *
 * 주의: (2)와 (3) 사이 crash 시 재실행하면 sidecar 에 같은 row 가 한 번 더 append
 * 될 수 있다 (.bak 으로 복구 가능 — sidecar 소비 시 eventId dedup 권장).
 *
 * Usage (operator 가 직접 실행 — 분석 파이프라인에서 자동 호출 금지):
 *   npx ts-node scripts/quarantine-synthetic-markout-rows.ts                 # data/realtime 대상
 *   npx ts-node scripts/quarantine-synthetic-markout-rows.ts --dry-run       # 변경 없이 카운트만
 *   npx ts-node scripts/quarantine-synthetic-markout-rows.ts --realtime-dir <dir>
 */
import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';

export const BASE58_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const MARKOUT_LEDGER_FILES = [
  'trade-markout-anchors.jsonl',
  'trade-markouts.jsonl',
] as const;

export interface QuarantineFileResult {
  file: string;
  existed: boolean;
  totalRows: number;
  keptRows: number;
  quarantinedRows: number;
  unparseableLines: number;
  backupPath: string | null;
  quarantinePath: string | null;
  dryRun: boolean;
}

export function isSyntheticMarkoutRow(row: Record<string, unknown>): boolean {
  // tokenMint 가 없거나 base58 (32-44자) 가 아니면 실제 mint 와 join 불가 → synthetic 판정.
  const tokenMint = row.tokenMint;
  return typeof tokenMint !== 'string' || !BASE58_MINT_RE.test(tokenMint);
}

function backupTimestamp(now: Date): string {
  // 파일명 안전한 UTC timestamp — 예: 20260610T130651Z
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function quarantineOneFile(options: {
  realtimeDir: string;
  fileName: string;
  dryRun: boolean;
  now: Date;
}): Promise<QuarantineFileResult> {
  const filePath = path.join(options.realtimeDir, options.fileName);
  const result: QuarantineFileResult = {
    file: filePath,
    existed: true,
    totalRows: 0,
    keptRows: 0,
    quarantinedRows: 0,
    unparseableLines: 0,
    backupPath: null,
    quarantinePath: null,
    dryRun: options.dryRun,
  };

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      result.existed = false;
      return result;
    }
    throw err;
  }

  const keptLines: string[] = [];
  const quarantinedLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let row: Record<string, unknown> | null = null;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // 파싱 불가 line 은 synthetic 판정 불가 — 보수적으로 원본에 유지.
      result.unparseableLines += 1;
      keptLines.push(line);
      continue;
    }
    result.totalRows += 1;
    if (isSyntheticMarkoutRow(row)) {
      quarantinedLines.push(line);
    } else {
      keptLines.push(line);
    }
  }
  result.keptRows = result.totalRows - quarantinedLines.length;
  result.quarantinedRows = quarantinedLines.length;

  // 이동할 row 가 없으면 백업/재작성도 하지 않는다 (원장 무변경).
  if (result.quarantinedRows === 0 || options.dryRun) return result;

  // (1) timestamped 백업 — rewrite 실패 대비 원본 보존.
  const backupPath = `${filePath}.bak-${backupTimestamp(options.now)}`;
  await copyFile(filePath, backupPath);
  result.backupPath = backupPath;

  // (2) quarantine sidecar — append (재실행 시 기존 격리분 보존). 원본 line 바이트 그대로 이동.
  const quarantineDir = path.join(options.realtimeDir, 'quarantine');
  await mkdir(quarantineDir, { recursive: true });
  const quarantinePath = path.join(
    quarantineDir,
    options.fileName.replace(/\.jsonl$/, '.synthetic.jsonl')
  );
  await appendFile(quarantinePath, quarantinedLines.join('\n') + '\n', 'utf8');
  result.quarantinePath = quarantinePath;

  // (3) 원본 atomic 재작성 — 부분 쓰기 중 crash 가 원장을 깨지 않도록 tmp + rename.
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  const body = keptLines.length > 0 ? keptLines.join('\n') + '\n' : '';
  await writeFile(tmpPath, body, 'utf8');
  await rename(tmpPath, filePath);

  return result;
}

export async function quarantineSyntheticMarkoutRows(options: {
  realtimeDir: string;
  dryRun?: boolean;
  now?: Date;
}): Promise<QuarantineFileResult[]> {
  const results: QuarantineFileResult[] = [];
  for (const fileName of MARKOUT_LEDGER_FILES) {
    results.push(
      await quarantineOneFile({
        realtimeDir: options.realtimeDir,
        fileName,
        dryRun: options.dryRun === true,
        now: options.now ?? new Date(),
      })
    );
  }
  return results;
}

function parseArgs(argv: string[]): { realtimeDir: string; dryRun: boolean } {
  let realtimeDir = process.env.REALTIME_DATA_DIR ?? path.resolve(process.cwd(), 'data/realtime');
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--realtime-dir') {
      const value = argv[++i];
      if (!value) throw new Error('--realtime-dir requires a directory argument');
      realtimeDir = path.resolve(value);
    } else if (argv[i] === '--dry-run') dryRun = true;
  }
  return { realtimeDir, dryRun };
}

async function main(): Promise<void> {
  const { realtimeDir, dryRun } = parseArgs(process.argv.slice(2));
  const results = await quarantineSyntheticMarkoutRows({ realtimeDir, dryRun });

  /* eslint-disable no-console */
  console.log(`quarantine-synthetic-markout-rows ${dryRun ? '(dry-run)' : ''}`);
  console.log(`realtimeDir=${realtimeDir}`);
  for (const r of results) {
    if (!r.existed) {
      console.log(`- ${path.basename(r.file)}: missing (skipped)`);
      continue;
    }
    console.log(
      `- ${path.basename(r.file)}: total=${r.totalRows} kept=${r.keptRows} ` +
      `quarantined=${r.quarantinedRows} unparseable=${r.unparseableLines}` +
      (r.backupPath ? ` backup=${r.backupPath}` : '') +
      (r.quarantinePath ? ` quarantine=${r.quarantinePath}` : '')
    );
  }
  /* eslint-enable no-console */
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[quarantine-synthetic-markout-rows] failed:', err);
    process.exitCode = 1;
  });
}
