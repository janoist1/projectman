import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ProjectFocusItem, ProjectFocusView } from '@projectman/shared';
import { queryKeys } from '../../api/queryKeys';
import { FocusSaves, savesFor } from './focusSaves';

const item = (key: string): ProjectFocusItem => ({
  key,
  addedAt: '2026-10-01T10:00:00.000Z',
  addedBy: { kind: 'human', handle: 'owner' },
});
const view = (...keys: string[]): ProjectFocusView => ({ items: keys.map(item), canEdit: true });

/** A request the test settles by hand. */
function deferred() {
  let resolve!: (value: ProjectFocusView) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ProjectFocusView>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const append = (key: string) => (list: readonly ProjectFocusItem[]) => [...list, item(key)];
const shown = (saves: FocusSaves, server: ProjectFocusItem[]) =>
  saves
    .snapshot()
    .reduce<readonly ProjectFocusItem[]>((list, change) => change.apply(list), server)
    .map((entry) => entry.key);

describe('the focus saves', () => {
  it('shows a change at once, and keeps the server answer when the request is done', async () => {
    const client = new QueryClient();
    const saves = new FocusSaves(client, 'AC');
    const request = deferred();
    const done = saves.save(append('AC-1'), () => request.promise);
    expect(shown(saves, [])).toEqual(['AC-1']);
    request.resolve(view('AC-1'));
    await done;
    expect(saves.snapshot()).toHaveLength(0);
    expect(client.getQueryData<ProjectFocusView>(queryKeys.focus('AC'))?.items.map((i) => i.key)).toEqual([
      'AC-1',
    ]);
  });

  it('sends the requests one after the other, in the order they were made', async () => {
    const saves = new FocusSaves(new QueryClient(), 'AC');
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    const one = saves.save(append('AC-1'), () => {
      started.push('one');
      return first.promise;
    });
    const two = saves.save(append('AC-2'), () => {
      started.push('two');
      return second.promise;
    });
    await Promise.resolve();
    expect(started).toEqual(['one']);
    first.resolve(view('AC-1'));
    await one;
    await Promise.resolve();
    expect(started).toEqual(['one', 'two']);
    second.resolve(view('AC-1', 'AC-2'));
    await two;
  });

  it('drops only the refused change: a late error does not overwrite another save', async () => {
    const client = new QueryClient();
    const saves = new FocusSaves(client, 'AC');
    const first = deferred();
    const second = deferred();
    const one = saves.save(append('AC-1'), () => first.promise);
    const two = saves.save(append('AC-2'), () => second.promise);
    expect(shown(saves, [])).toEqual(['AC-1', 'AC-2']);
    first.reject(new Error('refused'));
    await expect(one).rejects.toThrow('refused');
    // The first change is gone, the second still shows on top of the server's list.
    expect(shown(saves, [])).toEqual(['AC-2']);
    second.resolve(view('AC-2'));
    await two;
    expect(saves.snapshot()).toHaveLength(0);
    expect(client.getQueryData<ProjectFocusView>(queryKeys.focus('AC'))?.items.map((i) => i.key)).toEqual([
      'AC-2',
    ]);
  });

  it('is one store per client and project', () => {
    const client = new QueryClient();
    expect(savesFor(client, 'AC')).toBe(savesFor(client, 'AC'));
    expect(savesFor(client, 'AC')).not.toBe(savesFor(client, 'XY'));
    expect(savesFor(client, 'AC')).not.toBe(savesFor(new QueryClient(), 'AC'));
  });
});
