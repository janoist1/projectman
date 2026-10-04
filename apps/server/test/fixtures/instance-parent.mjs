/**
 * Test helper for instance.test.ts: starts a throwaway instance, prints its URLs as one JSON line,
 * then waits. The test kills this process with SIGKILL and checks that nothing is left running.
 */
import { startInstance } from '../../../../scripts/lib/instance.mjs';

const instance = await startInstance({ seed: 'none' });
console.log(JSON.stringify({ serverUrl: instance.serverUrl, webUrl: instance.webUrl, dir: instance.dir }));
setInterval(() => {}, 60_000);
