import { spawn } from 'node:child_process';
import os from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import type { PlanUsage } from '@projectman/shared';
import type { PlanUsageProvider } from '../../../contracts';
import { runPromise } from '../../../kernel';
import { probeWithin, type ProbeProcess } from './plan-usage-probe';
import { resolveCommand } from '../../cli';
import { buildChildEnv } from '../../env';
import { rec, type Json } from '../../transcript/json';

/**
 * Plan usage (the 5-hour and weekly limits of the logged-in Claude account), the numbers
 * Claude Code's /usage screen shows.
 *
 * Approach from agent-office (MIT, src/server/limits.ts): start `claude -p` with the
 * stream-json protocol and send a single `get_usage` control request. No prompt is sent, so
 * no conversation starts and nothing is spent; Claude Code handles its own sign-in
 * (keychain, token refresh), so projectman never reads or stores Claude credentials. The
 * process runs without user/project settings, tools, MCP servers or session persistence,
 * with the same billing-safe environment as member sessions.
 */

interface PlanUsageOptions {
  claudeBin: string;
  logger: FastifyBaseLogger;
  /** Results are reused for this long (default two minutes). */
  minIntervalMs?: number;
  /** A probe that takes longer is abandoned (default 30 s). */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const PROBE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--tools',
  '',
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
];

const REQUEST_ID = 'projectman-usage';
const KILL_AFTER_MS = 5_000;

function percent(window: Json | null): number | null {
  const value = window?.utilization;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function resetsAt(window: Json | null): string | null {
  const value = window?.resets_at;
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  return null;
}

/** Maps Claude Code's get_usage answer; null when the account has no plan limits (API key). */
export function toPlanUsage(answer: unknown, now: Date = new Date()): PlanUsage | null {
  const a = rec(answer);
  if (!a || a.rate_limits_available === false) return null;
  const limits = rec(a.rate_limits);
  if (!limits) return null;
  const fiveHour = rec(limits.five_hour);
  const weekly = rec(limits.seven_day);
  if (!fiveHour && !weekly) return null;
  return {
    fiveHourPercent: percent(fiveHour),
    weeklyPercent: percent(weekly),
    fiveHourResetsAt: resetsAt(fiveHour),
    weeklyResetsAt: resetsAt(weekly),
    fetchedAt: now.toISOString(),
  };
}

/** Runs one probe; resolves to Claude Code's answer, or null when it gave none. */
function probeUsage(claudeBin: string, env: Record<string, string>, timeoutMs: number): Promise<unknown> {
  try {
    const { file, args } = resolveCommand(claudeBin, PROBE_ARGS);
    let buffer = '';
    const child = spawn(file, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
    let finish!: (value: unknown) => void;
    let finishClosed!: () => void;
    const answer = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      finishClosed = resolve;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const m = rec(message);
        const response = m?.type === 'control_response' ? rec(m.response) : null;
        if (response?.request_id === REQUEST_ID) {
          finish(response.subtype === 'success' ? (response.response ?? null) : null);
        }
      }
    });
    child.on('error', () => {
      finish(null);
      if (child.pid === undefined) finishClosed();
    });
    child.on('close', () => {
      finish(null);
      finishClosed();
    });
    child.stdin.on('error', () => undefined);
    child.stdin.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: REQUEST_ID,
        request: { subtype: 'get_usage', skip_behaviors: true },
      })}\n`,
    );
    const process: ProbeProcess = {
      answer,
      closed,
      end: () => child.stdin.end(),
      running: () => child.pid !== undefined && child.exitCode === null && child.signalCode === null,
      kill: () => {
        child.kill('SIGKILL');
      },
    };
    return runPromise(probeWithin(process, timeoutMs, KILL_AFTER_MS));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function createPlanUsageProvider(opts: PlanUsageOptions): PlanUsageProvider {
  const minIntervalMs = opts.minIntervalMs ?? 120_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const logger = opts.logger;
  let last: { value: PlanUsage | null; at: number } | null = null;
  let inflight: Promise<PlanUsage | null> | null = null;

  const refresh = async (): Promise<PlanUsage | null> => {
    const env = buildChildEnv(opts.env ?? process.env);
    const answer = await probeUsage(opts.claudeBin, env, timeoutMs);
    if (answer === null) {
      logger.warn('plan usage: claude gave no answer');
      // Keep showing the last known numbers rather than nothing.
      last = { value: last?.value ?? null, at: Date.now() };
      return last.value;
    }
    const value = toPlanUsage(answer);
    last = { value, at: Date.now() };
    return value;
  };

  return {
    get(): Promise<PlanUsage | null> {
      if (last && Date.now() - last.at < minIntervalMs) return Promise.resolve(last.value);
      if (!inflight) {
        inflight = refresh().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}
