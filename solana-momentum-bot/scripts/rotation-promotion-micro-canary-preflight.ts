#!/usr/bin/env ts-node
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

type GateStatus = 'READY' | 'WAIT' | 'REJECT';
type PreflightVerdict = 'BLOCKED' | 'READY_FOR_MANUAL_REVIEW' | 'INVALID_GATEKEEPER';

interface Args {
  gatekeeperReport: string;
  jsonOut?: string;
  mdOut?: string;
}

interface MicroCanaryPlan {
  reviewAllowed?: boolean;
  liveAutoEnableAllowed?: boolean;
  preflightStatus?: string;
  targetArm?: string;
  floorSol?: number;
  maxSleeveLossSol?: number;
  maxCloseCount?: number;
  minActiveDays?: number;
  maxTicketSol?: number;
  requiredEnvDiff?: string[];
  rollbackConditions?: string[];
  stopRules?: string[];
}

interface GatekeeperReportInput {
  generatedAt?: string;
  status?: GateStatus;
  primaryWindowStatus?: GateStatus;
  primaryBlockerDisposition?: string;
  nextAction?: string;
  reasons?: string[];
  microCanaryPlan?: MicroCanaryPlan;
}

export interface RotationPromotionMicroCanaryPreflightReport {
  generatedAt: string;
  verdict: PreflightVerdict;
  nextAction: string;
  sourceGeneratedAt: string | null;
  gateStatus: GateStatus | null;
  primaryBlockerDisposition: string | null;
  liveAutoEnableAllowed: false;
  reviewAllowed: boolean;
  targetArm: string | null;
  maxTicketSol: number | null;
  maxSleeveLossSol: number | null;
  maxCloseCount: number | null;
  minActiveDays: number | null;
  requiredEnvDiff: string[];
  rollbackConditions: string[];
  stopRules: string[];
  reasons: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    gatekeeperReport: path.join('reports', `rotation-promotion-gatekeeper-${new Date().toISOString().slice(0, 10)}.json`),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--gatekeeper-report' && next) {
      args.gatekeeperReport = next;
      i += 1;
    } else if (arg.startsWith('--gatekeeper-report=')) {
      args.gatekeeperReport = arg.slice('--gatekeeper-report='.length);
    } else if (arg === '--json-out' && next) {
      args.jsonOut = next;
      i += 1;
    } else if (arg.startsWith('--json-out=')) {
      args.jsonOut = arg.slice('--json-out='.length);
    } else if (arg === '--md-out' && next) {
      args.mdOut = next;
      i += 1;
    } else if (arg.startsWith('--md-out=')) {
      args.mdOut = arg.slice('--md-out='.length);
    }
  }
  return args;
}

async function readGatekeeperReport(file: string): Promise<GatekeeperReportInput | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as GatekeeperReportInput;
  } catch {
    return null;
  }
}

function isGateStatus(value: unknown): value is GateStatus {
  return value === 'READY' || value === 'WAIT' || value === 'REJECT';
}

export function buildRotationPromotionMicroCanaryPreflightReport(
  input: GatekeeperReportInput | null
): RotationPromotionMicroCanaryPreflightReport {
  const plan = input?.microCanaryPlan ?? {};
  const gateStatus = isGateStatus(input?.status) ? input.status : null;
  if (!input || gateStatus == null) {
    return {
      generatedAt: new Date().toISOString(),
      verdict: 'INVALID_GATEKEEPER',
      nextAction: 'generate a valid gatekeeper report before reviewing live changes',
      sourceGeneratedAt: input?.generatedAt ?? null,
      gateStatus,
      primaryBlockerDisposition: input?.primaryBlockerDisposition ?? null,
      liveAutoEnableAllowed: false,
      reviewAllowed: false,
      targetArm: null,
      maxTicketSol: null,
      maxSleeveLossSol: null,
      maxCloseCount: null,
      minActiveDays: null,
      requiredEnvDiff: ['none'],
      rollbackConditions: [],
      stopRules: [],
      reasons: ['gatekeeper report missing or invalid'],
    };
  }

  const ready = gateStatus === 'READY' && plan.reviewAllowed === true && plan.preflightStatus === 'READY_FOR_MANUAL_REVIEW';
  const reasons = ready
    ? ['gatekeeper status READY; manual review packet may be prepared']
    : [
      `gatekeeper status ${gateStatus} is not READY`,
      ...(input.reasons ?? []),
    ];
  const verdict: PreflightVerdict = ready ? 'READY_FOR_MANUAL_REVIEW' : 'BLOCKED';
  const nextAction = ready
    ? 'prepare manual micro-canary review packet; live auto-enable remains forbidden'
    : 'do not change live env or canary allowlist; keep collecting proof';
  return {
    generatedAt: new Date().toISOString(),
    verdict,
    nextAction,
    sourceGeneratedAt: input.generatedAt ?? null,
    gateStatus,
    primaryBlockerDisposition: input.primaryBlockerDisposition ?? null,
    liveAutoEnableAllowed: false,
    reviewAllowed: ready,
    targetArm: plan.targetArm ?? null,
    maxTicketSol: typeof plan.maxTicketSol === 'number' ? plan.maxTicketSol : null,
    maxSleeveLossSol: typeof plan.maxSleeveLossSol === 'number' ? plan.maxSleeveLossSol : null,
    maxCloseCount: typeof plan.maxCloseCount === 'number' ? plan.maxCloseCount : null,
    minActiveDays: typeof plan.minActiveDays === 'number' ? plan.minActiveDays : null,
    requiredEnvDiff: ready ? plan.requiredEnvDiff ?? [] : ['none; gatekeeper is not READY'],
    rollbackConditions: ready ? plan.rollbackConditions ?? [] : [],
    stopRules: ready ? plan.stopRules ?? [] : [],
    reasons,
  };
}

function fmt(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(6);
}

export function renderRotationPromotionMicroCanaryPreflightReport(
  report: RotationPromotionMicroCanaryPreflightReport
): string {
  const lines: string[] = [];
  lines.push('# Rotation Promotion Micro-Canary Preflight');
  lines.push('');
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: ${report.verdict}`);
  lines.push(`- gateStatus: ${report.gateStatus ?? 'n/a'}`);
  lines.push(`- liveAutoEnableAllowed: ${report.liveAutoEnableAllowed}`);
  lines.push(`- reviewAllowed: ${report.reviewAllowed}`);
  lines.push(`- nextAction: ${report.nextAction}`);
  lines.push(`- reasons: ${report.reasons.join('; ')}`);
  lines.push('');
  lines.push('## Sleeve');
  lines.push(`- targetArm: ${report.targetArm ?? 'n/a'}`);
  lines.push(`- maxTicketSol: ${fmt(report.maxTicketSol)}`);
  lines.push(`- maxSleeveLossSol: ${fmt(report.maxSleeveLossSol)}`);
  lines.push(`- maxCloseCount: ${report.maxCloseCount ?? 'n/a'}`);
  lines.push(`- minActiveDays: ${report.minActiveDays ?? 'n/a'}`);
  lines.push('');
  lines.push('## Required Env Diff');
  for (const item of report.requiredEnvDiff) lines.push(`- ${item}`);
  if (report.rollbackConditions.length > 0) {
    lines.push('');
    lines.push('## Rollback Conditions');
    for (const item of report.rollbackConditions) lines.push(`- ${item}`);
  }
  if (report.stopRules.length > 0) {
    lines.push('');
    lines.push('## Stop Rules');
    for (const item of report.stopRules) lines.push(`- ${item}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const input = await readGatekeeperReport(args.gatekeeperReport);
  const report = buildRotationPromotionMicroCanaryPreflightReport(input);
  const md = renderRotationPromotionMicroCanaryPreflightReport(report);
  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, md, 'utf8');
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (!args.mdOut) process.stdout.write(md);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
