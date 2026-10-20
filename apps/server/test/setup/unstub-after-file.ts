import { afterAll, vi } from 'vitest';

/**
 * The `pooled` project (PM-865) shares one process and its globals between the files of a worker, and
 * a plain vitest run starts each file with fresh ones. `vi.stubEnv` and `vi.stubGlobal` are put back
 * when the file is done. Not after each test (`unstubEnvs`): a stub made in `beforeAll` has to last
 * for the whole file.
 */
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
