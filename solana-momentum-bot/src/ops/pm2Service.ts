import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface Pm2ProcessStatus {
  name: string;
  status: string;
  pid: number | null;
  restarts: number;
  cpuPct: number;
  memoryMb: number;
  uptimeMs: number | null;
}

interface Pm2CommandOutput {
  stdout: string;
  stderr: string;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const ENV_ASSIGNMENT_PATTERN = /\b([A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*)=([^\s]+)/g;
const LOG_FILES: Record<string, { out: string; error: string }> = {
  'momentum-bot': {
    out: 'logs/bot-out.log',
    error: 'logs/bot-error.log',
  },
  'momentum-shadow': {
    out: 'logs/shadow-out.log',
    error: 'logs/shadow-error.log',
  },
  'momentum-ops-bot': {
    out: 'logs/ops-out.log',
    error: 'logs/ops-error.log',
  },
};
const ECOSYSTEM_CONFIG_FILE = 'ecosystem.config.cjs';

export class Pm2Service {
  async listProcesses(): Promise<Pm2ProcessStatus[]> {
    const { stdout } = await this.run(['jlist']);
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;

    return parsed.map((entry) => {
      const pm2Env = toRecord(entry.pm2_env);
      const monit = toRecord(entry.monit);
      const uptime = typeof pm2Env.pm_uptime === 'number' ? Date.now() - pm2Env.pm_uptime : null;

      return {
        name: String(entry.name || 'unknown'),
        status: String(pm2Env.status || 'unknown'),
        pid: typeof entry.pid === 'number' && entry.pid > 0 ? entry.pid : null,
        restarts: typeof pm2Env.restart_time === 'number' ? pm2Env.restart_time : 0,
        cpuPct: typeof monit.cpu === 'number' ? monit.cpu : 0,
        memoryMb: typeof monit.memory === 'number' ? Math.round(monit.memory / 1024 / 1024) : 0,
        uptimeMs: uptime,
      };
    });
  }

  async restartProcess(name: string): Promise<string> {
    const ecosystemConfigPath = path.resolve(process.cwd(), ECOSYSTEM_CONFIG_FILE);
    const args = buildRestartProcessArgs(name, fs.existsSync(ecosystemConfigPath), ecosystemConfigPath);
    const output = await this.run(args);
    const note = args[0] === 'startOrRestart'
      ? `\nApplied ecosystem config: ${ECOSYSTEM_CONFIG_FILE}`
      : '';
    return sanitizePm2Output(joinOutput(output) + note);
  }

  async stopProcess(name: string): Promise<string> {
    const output = await this.run(['stop', name]);
    return sanitizePm2Output(joinOutput(output));
  }

  async readLogs(name: string, lines = 30): Promise<string> {
    const files = resolveLogFiles(name);
    const existingFiles = files.filter((file) => fs.existsSync(file));
    if (existingFiles.length === 0) {
      throw new Error(`No log files found for ${name}`);
    }

    const output = await this.runCommand(
      'tail',
      ['-n', String(lines), '-v', ...existingFiles],
      20_000
    );
    return sanitizePm2Output(joinOutput(output));
  }

  private run(args: string[], timeoutMs = 15_000): Promise<Pm2CommandOutput> {
    return this.runCommand('pm2', args, timeoutMs);
  }

  private runCommand(command: string, args: string[], timeoutMs: number): Promise<Pm2CommandOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: string[] = [];
      const stderr: string[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`${command} command timed out: ${args.join(' ')}`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
      child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = { stdout: stdout.join(''), stderr: stderr.join('') };
        if (code === 0) {
          resolve(output);
          return;
        }
        reject(new Error(sanitizePm2Output(joinOutput(output)) || `${command} exited with code ${code}`));
      });
    });
  }
}

export function buildRestartProcessArgs(
  name: string,
  ecosystemConfigExists: boolean,
  ecosystemConfigPath = path.resolve(process.cwd(), ECOSYSTEM_CONFIG_FILE)
): string[] {
  if (!ecosystemConfigExists) {
    return ['restart', name, '--update-env'];
  }

  return ['startOrRestart', ecosystemConfigPath, '--only', name, '--update-env'];
}

function resolveLogFiles(name: string): string[] {
  const entry = LOG_FILES[name];
  if (!entry) {
    throw new Error(`No log file mapping defined for ${name}`);
  }
  return [entry.error, entry.out].map((file) => path.resolve(process.cwd(), file));
}

function joinOutput(output: Pm2CommandOutput): string {
  return [output.stdout.trim(), output.stderr.trim()].filter(Boolean).join('\n');
}

function sanitizePm2Output(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(ENV_ASSIGNMENT_PATTERN, '$1=[redacted]')
    .trim();
}

function toRecord(value: unknown): Record<string, number | string> {
  if (value && typeof value === 'object') {
    return value as Record<string, number | string>;
  }
  return {};
}
