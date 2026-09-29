import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, tempDirs } from '../../test-helpers';
import { CodexPlanUsage, toCodexPlanUsage } from './plan-usage';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const now = new Date('2026-03-10T12:00:00.000Z');
const unix = (iso: string) => Date.parse(iso) / 1000;

function tokenCount(at: string, primary: number, secondary: number): string {
  return JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: primary, window_minutes: 300, resets_at: unix('2026-03-10T14:00:00.000Z') },
        secondary: {
          used_percent: secondary,
          window_minutes: 10080,
          resets_at: unix('2026-03-14T00:00:00.000Z'),
        },
      },
    },
  });
}

async function rollout(
  home: string,
  day: string,
  name: string,
  lines: string[],
  mtime: Date,
): Promise<string> {
  const dir = path.join(home, 'sessions', ...day.split('-'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, `${lines.join('\n')}\n`);
  await utimes(file, mtime, mtime);
  return file;
}

describe('toCodexPlanUsage', () => {
  it('maps the short and the weekly window by length', () => {
    expect(
      toCodexPlanUsage(
        {
          at: '2026-03-10T11:59:00.000Z',
          limitId: 'codex',
          primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: unix('2026-03-10T14:00:00.000Z') },
          secondary: { usedPercent: 101, windowMinutes: 10080, resetsAt: unix('2026-03-14T00:00:00.000Z') },
        },
        now,
      ),
    ).toEqual({
      fiveHourPercent: 12.5,
      weeklyPercent: 100,
      fiveHourResetsAt: '2026-03-10T14:00:00.000Z',
      weeklyResetsAt: '2026-03-14T00:00:00.000Z',
      fetchedAt: '2026-03-10T11:59:00.000Z',
    });
  });

  it('handles a plan with only a weekly window, and windows that reset since the record', () => {
    expect(
      toCodexPlanUsage(
        {
          at: '2026-03-01T00:00:00.000Z',
          limitId: null,
          primary: { usedPercent: 90, windowMinutes: 10080, resetsAt: unix('2026-03-05T00:00:00.000Z') },
          secondary: null,
        },
        now,
      ),
    ).toEqual({
      fiveHourPercent: null,
      weeklyPercent: null, // reset on March 5: unknown now, not 90
      fiveHourResetsAt: null,
      weeklyResetsAt: null,
      fetchedAt: '2026-03-01T00:00:00.000Z',
    });
  });
});

describe('CodexPlanUsage', () => {
  it('uses the newest record among the most recently written rollouts', async () => {
    const home = await dirs.make('codex-home-');
    await rollout(
      home,
      '2026-03-09',
      'rollout-2026-03-09T08-00-00-a.jsonl',
      [
        tokenCount('2026-03-09T08:10:00.000Z', 5, 30),
        '{"type":"event_msg","payload":{"type":"task_complete"}}',
      ],
      new Date('2026-03-09T08:10:00.000Z'),
    );
    await rollout(
      home,
      '2026-03-10',
      'rollout-2026-03-10T09-00-00-b.jsonl',
      [
        tokenCount('2026-03-10T09:05:00.000Z', 10, 35),
        tokenCount('2026-03-10T09:30:00.000Z', 15, 40),
        'partial',
      ],
      new Date('2026-03-10T09:30:00.000Z'),
    );
    const usage = new CodexPlanUsage({ codexHome: home, logger: silentLogger(), now: () => now });
    expect(await usage.get()).toMatchObject({
      fiveHourPercent: 15,
      weeklyPercent: 40,
      fetchedAt: '2026-03-10T09:30:00.000Z',
    });
  });

  it('also reads noted transcripts of live sessions, and caches results', async () => {
    const home = await dirs.make('codex-home-');
    const old = await rollout(
      home,
      '2025-01-01',
      'rollout-2025-01-01T00-00-00-c.jsonl',
      [tokenCount('2026-03-10T11:00:00.000Z', 60, 70)],
      new Date('2026-03-10T11:00:00.000Z'),
    );
    // Many newer days push the resumed session's folder out of the scan.
    for (let d = 1; d <= 20; d++) {
      const day = `2026-02-${String(d).padStart(2, '0')}`;
      await rollout(
        home,
        day,
        `rollout-${day}T00-00-00-x${d}.jsonl`,
        ['{}'],
        new Date(`${day}T00:00:00.000Z`),
      );
    }
    const usage = new CodexPlanUsage({
      codexHome: home,
      logger: silentLogger(),
      now: () => now,
      minIntervalMs: 0,
    });
    expect(await usage.get()).toBeNull();
    usage.noteTranscript(old);
    expect(await usage.get()).toMatchObject({ fiveHourPercent: 60, weeklyPercent: 70 });

    const cached = new CodexPlanUsage({ codexHome: home, logger: silentLogger(), now: () => now });
    expect(await cached.get()).toBeNull();
    cached.noteTranscript(old);
    expect(await cached.get()).toBeNull(); // within the minute: the first answer stands
  });

  it('is unknown without transcripts', async () => {
    const usage = new CodexPlanUsage({
      codexHome: path.join(await dirs.make(), 'missing'),
      logger: silentLogger(),
    });
    expect(await usage.get()).toBeNull();
  });
});
