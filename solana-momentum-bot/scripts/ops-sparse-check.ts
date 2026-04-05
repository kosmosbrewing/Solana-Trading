/* eslint-disable no-console */
import path from 'path';
import { buildSparseOpsSummaryMessage, loadSparseOpsSummary } from '../src/reporting/sparseOpsSummary';

async function main() {
  const args = process.argv.slice(2);
  const hours = Math.max(1, Number(getArg(args, '--hours') ?? '2'));
  const topN = Math.max(1, Number(getArg(args, '--top') ?? '5'));
  const realtimeRoot = path.resolve(getArg(args, '--data-dir') ?? process.env.REALTIME_DATA_DIR ?? 'data/realtime');
  const summary = loadSparseOpsSummary(realtimeRoot, hours, topN);
  const message = buildSparseOpsSummaryMessage(summary);

  console.log('Sparse Ops Check');
  console.log('='.repeat(72));
  console.log(message ?? `- 최근 ${hours}h sparse 진단 데이터 없음`);
}

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

main().catch((error) => {
  console.error(`ops-sparse-check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
