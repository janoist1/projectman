import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_EXIT } from '@projectman/shared';
import { main } from '../../../scripts/projectman/cli';
import {
  CANARY_KEY,
  createClientHome,
  createTestIo,
  jsonResponse,
  type ClientHome,
  type Handler,
  type TestIoOptions,
} from './helpers/projectman-client';

const event = (seq: number, kind = 'task') => ({
  cursor: `c${seq}`,
  projectKey: 'PM',
  kind,
  entityId: `PM-${seq}`,
  at: `2026-10-18T10:00:0${seq}.000Z`,
});
const page = (seqs: number[], next: string) =>
  jsonResponse({ events: seqs.map((seq) => event(seq)), nextCursor: next });
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

describe('projectman events follow (PM-765)', () => {
  let fx: ClientHome;
  let cursorFile: string;
  beforeEach(() => {
    fx = createClientHome();
    cursorFile = path.join(fx.home, 'cursor');
  });
  afterEach(() => fx.cleanup());

  const follow = async (extra: string[], handler: Handler, options: TestIoOptions = {}) => {
    const t = createTestIo(fx.home, handler, options);
    // The handler may stop the run the way Ctrl-C does.
    const code = await main(['events', 'follow', '--project', 'PM', ...extra], t.io);
    return { code, ...t };
  };
  const searchOf = (url: URL) => Object.fromEntries(url.searchParams);

  it('long-polls the project journal with the maximum wait and prints one line per event', async () => {
    let t: ReturnType<typeof createTestIo> | undefined;
    const handler: Handler = (_request, index) => {
      if (index === 0) return page([1, 2], 'c2');
      t?.controller.abort();
      throw abortError();
    };
    t = createTestIo(fx.home, handler);
    const code = await main(['events', 'follow', '--project', 'PM'], t.io);
    expect(code).toBe(CLIENT_EXIT.ok);
    expect(t.requests[0]?.method).toBe('GET');
    expect(t.requests[0]?.url.pathname).toBe('/api/projects/PM/events');
    expect(searchOf(t.requests[0]!.url)).toEqual({ waitMs: '25000' });
    expect(searchOf(t.requests[1]!.url)).toEqual({ waitMs: '25000', after: 'c2' });
    expect(t.requests[0]?.headers['x-projectman-client']).toBe('cli');
    expect(t.requests[0]?.headers['x-request-id']).toBeUndefined();
    expect(t.stdout.join('')).toBe(
      '2026-10-18T10:00:01.000Z task PM-1 c1\n2026-10-18T10:00:02.000Z task PM-2 c2\n',
    );
  });

  it('--json prints each event as one JSON line', async () => {
    let t: ReturnType<typeof createTestIo> | undefined;
    t = createTestIo(fx.home, (_request, index) => {
      if (index === 0) return page([1], 'c1');
      t?.controller.abort();
      throw abortError();
    });
    expect(await main(['events', 'follow', '--project', 'PM', '--json'], t.io)).toBe(0);
    expect(t.stdout.map((line) => JSON.parse(line))).toEqual([event(1)]);
  });

  it('saves the cursor after each written event and resumes from the file', async () => {
    let first: ReturnType<typeof createTestIo> | undefined;
    first = createTestIo(fx.home, (_request, index) => {
      if (index === 0) return page([1, 2], 'c2');
      first?.controller.abort();
      throw abortError();
    });
    expect(await main(['events', 'follow', '--project', 'PM', '--cursor-file', cursorFile], first.io)).toBe(
      0,
    );
    expect(fs.readFileSync(cursorFile, 'utf8')).toBe('c2\n');
    expect(fs.statSync(cursorFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(fx.home).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    let second: ReturnType<typeof createTestIo> | undefined;
    second = createTestIo(fx.home, (_request, index) => {
      if (index === 0) return page([3], 'c3');
      second?.controller.abort();
      throw abortError();
    });
    expect(await main(['events', 'follow', '--project', 'PM', '--cursor-file', cursorFile], second.io)).toBe(
      0,
    );
    expect(searchOf(second.requests[0]!.url).after).toBe('c2');
    expect(fs.readFileSync(cursorFile, 'utf8')).toBe('c3\n');
  });

  it('an explicit --cursor wins over the file', async () => {
    fs.writeFileSync(cursorFile, 'c9\n');
    let t: ReturnType<typeof createTestIo> | undefined;
    t = createTestIo(fx.home, () => {
      t?.controller.abort();
      throw abortError();
    });
    expect(
      await main(
        ['events', 'follow', '--project', 'PM', '--cursor-file', cursorFile, '--cursor', 'c4'],
        t.io,
      ),
    ).toBe(0);
    expect(searchOf(t.requests[0]!.url).after).toBe('c4');
    expect(fs.readFileSync(cursorFile, 'utf8')).toBe('c9\n');
  });

  it('a long-poll that Ctrl-C aborts ends with status 0 and keeps the saved cursor', async () => {
    fs.writeFileSync(cursorFile, 'c5\n');
    let t: ReturnType<typeof createTestIo> | undefined;
    t = createTestIo(
      fx.home,
      (request) =>
        // The request is in flight when the signal comes; the fetch rejects as the real one does.
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason ?? abortError()));
          queueMicrotask(() => t?.controller.abort());
        }),
    );
    expect(await main(['events', 'follow', '--project', 'PM', '--cursor-file', cursorFile], t.io)).toBe(0);
    expect(t.requests).toHaveLength(1);
    expect(t.stderr.join('')).toBe('');
    expect(fs.readFileSync(cursorFile, 'utf8')).toBe('c5\n');
  });

  it('does not move the cursor past an event that could not be written: it is delivered again', async () => {
    const t = createTestIo(fx.home, () => page([1, 2, 3], 'c3'), { failStdoutFrom: 2 });
    const code = await main(['events', 'follow', '--project', 'PM', '--cursor-file', cursorFile], t.io);
    expect(code).toBe(CLIENT_EXIT.failed);
    expect(t.stdout).toHaveLength(1);
    expect(fs.readFileSync(cursorFile, 'utf8')).toBe('c1\n');
    expect(t.requests).toHaveLength(1);
    expect(t.stderr.join('')).toContain('standard output is closed');

    // The next run starts behind event 1, so event 2 comes again.
    let next: ReturnType<typeof createTestIo> | undefined;
    next = createTestIo(fx.home, (_request, index) => {
      if (index === 0) return page([2, 3], 'c3');
      next?.controller.abort();
      throw abortError();
    });
    await main(['events', 'follow', '--project', 'PM', '--cursor-file', cursorFile], next.io);
    expect(searchOf(next.requests[0]!.url).after).toBe('c1');
    expect(next.stdout.join('')).toContain(' c2\n');
  });

  it('does not write a cursor file when the very first event cannot be written', async () => {
    const t = createTestIo(fx.home, () => page([1], 'c1'), { failStdoutFrom: 1 });
    expect(await main(['events', 'follow', '--project', 'PM', '--cursor-file', cursorFile], t.io)).toBe(1);
    expect(fs.existsSync(cursorFile)).toBe(false);
  });

  it('retries a network failure after a growing pause, and says so on the error stream', async () => {
    const delays: number[] = [];
    let t: ReturnType<typeof createTestIo> | undefined;
    t = createTestIo(
      fx.home,
      (_request, index) => {
        if (index < 3) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
        if (index === 3) return page([1], 'c1');
        t?.controller.abort();
        throw abortError();
      },
      { delays },
    );
    expect(await main(['events', 'follow', '--project', 'PM'], t.io)).toBe(0);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(t.stderr.join('')).toContain('ECONNREFUSED');
    expect(t.stdout.join('')).toContain(' c1\n');
  });

  it('retries a gateway answer (502, 503, 504) like a network failure', async () => {
    const delays: number[] = [];
    let t: ReturnType<typeof createTestIo> | undefined;
    t = createTestIo(
      fx.home,
      (_request, index) => {
        if (index < 3)
          return new Response('<html>gateway</html>', { status: [502, 503, 504][index]!, headers: {} });
        if (index === 3) return page([1], 'c1');
        t?.controller.abort();
        throw abortError();
      },
      { delays },
    );
    expect(await main(['events', 'follow', '--project', 'PM'], t.io)).toBe(0);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(t.stderr.join('')).toContain('gateway');
    expect(t.stdout.join('')).toContain(' c1\n');
  });

  it.each([
    [401, 'integrator_key_invalid', CLIENT_EXIT.auth],
    [403, 'integrator_not_allowed', CLIENT_EXIT.failed],
    [410, 'event_cursor_expired', CLIENT_EXIT.failed],
    [400, 'invalid_event_cursor', CLIENT_EXIT.failed],
  ])('ends on %i %s with status %i and leaves the cursor file alone', async (status, code, exit) => {
    fs.writeFileSync(cursorFile, 'c5\n');
    const result = await follow(['--cursor-file', cursorFile], () =>
      jsonResponse({ error: { code, message: `refused ${code} ${CANARY_KEY}` } }, status),
    );
    expect(result.code).toBe(exit);
    expect(result.requests).toHaveLength(1);
    expect(result.stderr.join('')).toContain(code);
    expect(result.output()).not.toContain(CANARY_KEY);
    expect(fs.readFileSync(cursorFile, 'utf8')).toBe('c5\n');
  });

  it('refuses a cursor file that is a link, a directory, too large, or a credential file', async () => {
    const real = path.join(fx.home, 'real');
    fs.writeFileSync(real, 'c1');
    const link = path.join(fx.home, 'link');
    fs.symlinkSync(real, link);
    const directory = path.join(fx.home, 'dir');
    fs.mkdirSync(directory);
    const big = path.join(fx.home, 'big');
    fs.writeFileSync(big, 'x'.repeat(5000));
    for (const file of [link, directory, big, fx.keyFile, fx.configFile]) {
      const result = await follow(['--cursor-file', file], () => page([], 'c0'));
      expect(result.code, file).toBe(CLIENT_EXIT.usage);
      expect(result.requests, file).toEqual([]);
    }
    expect(fs.readFileSync(fx.keyFile, 'utf8')).toContain(CANARY_KEY);
  });

  it('an empty or missing cursor file starts at the beginning of the journal', async () => {
    fs.writeFileSync(cursorFile, '\n');
    for (const file of [cursorFile, path.join(fx.home, 'later')]) {
      let t: ReturnType<typeof createTestIo> | undefined;
      t = createTestIo(fx.home, () => {
        t?.controller.abort();
        throw abortError();
      });
      await main(['events', 'follow', '--project', 'PM', '--cursor-file', file], t.io);
      expect(searchOf(t.requests[0]!.url)).toEqual({ waitMs: '25000' });
    }
  });
});
