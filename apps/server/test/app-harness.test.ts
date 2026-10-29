import { describe, expect, it } from 'vitest';
import { createAppHarness } from './helpers/app-harness';

describe('app harness error logs', () => {
  it('fails cleanup when an unexpected server error was logged', async () => {
    const h = await createAppHarness();
    h.app.log.error('synthetic unexpected failure');
    await expect(h.close()).rejects.toThrow('unexpected app error logs');
  });

  it('accepts exactly the declared intentional errors, including after relaunch', async () => {
    const h = await createAppHarness({ expectedErrors: [/synthetic expected failure/] });
    await h.relaunch({ logger: false });
    h.app.log.error('synthetic expected failure');
    expect(h.errors).toHaveLength(1);
    await h.close();
  });
});
