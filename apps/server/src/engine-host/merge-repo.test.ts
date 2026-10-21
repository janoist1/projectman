import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUpstream } from './merge-repo';
import { runGit } from './merge-git';

vi.mock('./merge-git', () => ({ runGit: vi.fn(), outputTail: (text: string) => text }));

const upstream = { remote: 'origin', remoteRef: 'refs/heads/main', ref: 'refs/remotes/origin/main' };
const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
const turn = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
afterEach(() => vi.resetAllMocks());

describe('repository fetch queue', () => {
  it('serializes the same repository while different repositories run concurrently, and releases the key', async () => {
    let release!: (value: typeof ok) => void;
    vi.mocked(runGit)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(ok);
    const first = fetchUpstream('/repo/a', upstream, 42);
    const second = fetchUpstream('/repo/a', upstream, 42);
    const other = fetchUpstream('/repo/b', upstream, 42);
    await turn();
    expect(vi.mocked(runGit).mock.calls.map(([repo]) => repo)).toEqual(['/repo/a', '/repo/b']);
    await other;
    release(ok);
    await Promise.all([first, second]);
    expect(vi.mocked(runGit).mock.calls.map(([repo]) => repo)).toEqual(['/repo/a', '/repo/b', '/repo/a']);
    expect(runGit).toHaveBeenLastCalledWith(
      '/repo/a',
      [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--',
        'origin',
        '+refs/heads/main:refs/remotes/origin/main',
      ],
      { timeoutMs: 42 },
    );
    await fetchUpstream('/repo/a', upstream, 42);
    expect(runGit).toHaveBeenCalledTimes(4);
  });

  it('runs the successor after a failed fetch', async () => {
    vi.mocked(runGit)
      .mockResolvedValueOnce({ ...ok, code: 1, stderr: 'failed' })
      .mockResolvedValue(ok);
    const first = fetchUpstream('/repo/a', upstream, 42);
    const rejected = expect(first).rejects.toMatchObject({ code: 'git_failed' });
    const second = fetchUpstream('/repo/a', upstream, 42);
    await rejected;
    await second;
    expect(runGit).toHaveBeenCalledTimes(2);
  });
});
