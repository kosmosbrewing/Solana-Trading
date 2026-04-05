export interface SessionReplaySweepSectionRow {
  sessionId: string;
  summary: string;
}

export interface SessionReplaySweepTopProfile {
  id: string;
  summary: string;
}

export interface SessionReplaySweepReportInput {
  title: string;
  generatedAt: string;
  strategy: string;
  mode: string;
  gridPreset: string;
  gridSize: number;
  sessions: Array<{ id: string; storedSignals: number }>;
  topProfiles: SessionReplaySweepTopProfile[];
  bestProfileId?: string;
  bestProfileSummary?: string;
  bestProfileRows: SessionReplaySweepSectionRow[];
  notes: string[];
}

export function renderSessionReplaySweepReport(input: SessionReplaySweepReportInput): string {
  const lines: string[] = [
    `# ${input.title}`,
    '',
    `> Generated: ${input.generatedAt}`,
    `> Strategy: ${input.strategy}`,
    `> Mode: ${input.mode}`,
    `> Grid preset: ${input.gridPreset}`,
    `> Grid size: ${input.gridSize}`,
    '',
    '## Session Set',
    '',
    '| Session | Stored Signals |',
    '|---|---:|',
    ...input.sessions.map((session) => `| ${session.id} | ${session.storedSignals} |`),
    '',
    '## Top Profiles',
    '',
    '| Profile | Summary |',
    '|---|---|',
    ...input.topProfiles.map((profile) => `| ${profile.id} | ${escapePipes(profile.summary)} |`),
  ];

  if (input.bestProfileId) {
    lines.push(
      '',
      '## Best Profile',
      '',
      `- Profile: \`${input.bestProfileId}\``,
    );
    if (input.bestProfileSummary) {
      lines.push(`- Summary: ${input.bestProfileSummary}`);
    }
    lines.push(
      '',
      '## Best Profile By Session',
      '',
      '| Session | Summary |',
      '|---|---|',
      ...input.bestProfileRows.map((row) => `| ${row.sessionId} | ${escapePipes(row.summary)} |`)
    );
  }

  if (input.notes.length > 0) {
    lines.push('', '## Notes', '', ...input.notes.map((note) => `- ${note}`));
  }

  lines.push('');
  return lines.join('\n');
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, '\\|');
}
