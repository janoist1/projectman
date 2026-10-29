import { describe, expect, it, vi } from 'vitest';
import { DoneCleanup } from '../src/runtime/sessions/done-cleanup';

/** The cleanup of a done task (PM-1108): a task has one pending timer, however often it was moved to done. */
describe('the done task cleanup timer', () => {
  const setup = () => {
    const armed: Array<{ key: string; fire: () => void }> = [];
    const cleanup = new DoneCleanup({
      timers: {
        arm: (_group: string, key: string, _delay: number, fire: () => void) => armed.push({ key, fire }),
      },
      delayMs: 1,
    } as unknown as ConstructorParameters<typeof DoneCleanup>[0]);
    const run = vi.spyOn(cleanup, 'run').mockImplementation(() => {});
    return { cleanup, armed, run };
  };

  it('arms the same key for every move of a task, and runs with the member who moved it last', () => {
    const { cleanup, armed, run } = setup();
    cleanup.schedule('AR', 'AR-1', 'dev-1');
    cleanup.schedule('AR', 'AR-1', 'dev-2');
    cleanup.schedule('AR', 'AR-1');

    expect(new Set(armed.map((timer) => timer.key)).size).toBe(1);
    armed[0]!.fire();
    expect(run).toHaveBeenCalledExactlyOnceWith('AR', 'AR-1', 'dev-2');
  });
});
