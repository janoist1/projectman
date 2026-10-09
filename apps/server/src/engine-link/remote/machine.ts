import type { MachineProbe, MachineSnapshot } from '../../contracts';
import { conflict } from '../../domain/errors';
import { EngineCallError } from '../rpc';
import type { RemoteHub } from './hub';

/**
 * The machine display's probe in cloud mode (PM-315, PM-320): the display shows the default engine's
 * machine, so every reading is the engine's own (`machine.*`). The engine answers like the local probe:
 * a part it cannot read is null. A reading that does not arrive (the link is down) is as good as nothing
 * readable; the display itself is refused beforehand while there is no engine (`MachineMonitor.unavailable`).
 */

const EMPTY: MachineSnapshot = {
  cpu: null,
  cores: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  memoryPressure: null,
  swapUsedBytes: null,
  swapTotalBytes: null,
};

/** The variables `machine.env_values` returns: the engine answers nothing else about a process's environment. */
const ENGINE_ENV_NAMES = new Set(['PROJECTMAN_SESSION_ID', 'PROJECTMAN_INSTANCE']);

export interface RemoteMachineProbe extends MachineProbe {
  /** The display has an engine to show. */
  available(): boolean;
  /** The engine's own process, from its `hello`; null before it has connected. */
  identity(): { pid: number; uid: number | null; instanceTag?: string } | null;
}

export function createRemoteMachineProbe(options: { hub: RemoteHub }): RemoteMachineProbe {
  const { hub } = options;
  const engine = () => {
    const id = hub.defaultId();
    return id !== null && hub.available(id) ? id : null;
  };
  /** A reading, or `fallback` when the engine cannot answer. */
  async function read<T>(run: (id: string) => Promise<T>, fallback: T): Promise<T> {
    const id = engine();
    if (id === null) return fallback;
    try {
      return await run(id);
    } catch (error) {
      if (error instanceof EngineCallError) return fallback;
      throw error;
    }
  }
  return {
    available: () => engine() !== null,
    identity() {
      const id = hub.defaultId();
      const hello = id === null ? null : hub.mirror(id).hello;
      if (!hello) return null;
      return { pid: hello.pid, uid: hello.uid, instanceTag: hello.instanceTag ?? undefined };
    },
    machine: () => read((id) => hub.call(id, 'machine.snapshot', {}), EMPTY),
    processes: () => read((id) => hub.call(id, 'machine.processes', {}), null),
    async envValues(pids, names) {
      const wanted = names.filter((name) => ENGINE_ENV_NAMES.has(name));
      const result = new Map<number, Record<string, string>>();
      if (pids.length === 0 || wanted.length === 0) return result;
      const rows = await read((id) => hub.call(id, 'machine.env_values', { pids }), []);
      for (const row of rows) {
        const values: Record<string, string> = {};
        for (const name of wanted) {
          const value = (row.values as Record<string, string | undefined>)[name];
          if (value !== undefined) values[name] = value;
        }
        result.set(row.pid, values);
      }
      return result;
    },
    async signal(pid, signal) {
      const id = engine();
      if (id === null) throw conflict('engine_offline', 'The engine whose machine is shown is not connected');
      try {
        return await hub.call(id, 'machine.signal', { pid, signal });
      } catch (error) {
        // A signal that may or may not have been sent is not reported as "gone": the owner sees the failure.
        if (error instanceof EngineCallError)
          throw conflict('engine_offline', 'The engine did not answer the signal', { code: error.code });
        throw error;
      }
    },
  };
}
