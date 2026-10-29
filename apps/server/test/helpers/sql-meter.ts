import Database from 'better-sqlite3';
import { statementCount } from '../../src/db';

/** Counts executed native statements, including cached prepares, without retaining statement instances. */
export function instrumentSql(
  observe?: (
    statement: Database.Statement,
    method: 'all' | 'get' | 'run' | 'iterate',
    args: unknown[],
    result: unknown,
  ) => void,
  runtime = false,
) {
  const probe = new Database(':memory:');
  const prototype = Object.getPrototypeOf(probe.prepare('SELECT 1')) as Database.Statement;
  probe.close();
  const descriptors = new Map<string, PropertyDescriptor>();
  let active = false;
  let count = 0;
  let runtimeStart = 0;
  for (const method of ['all', 'get', 'run', 'iterate'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
    descriptors.set(method, descriptor);
    Object.defineProperty(prototype, method, {
      ...descriptor,
      value: function (this: Database.Statement, ...args: unknown[]) {
        const result: unknown = Reflect.apply(descriptor.value, this, args);
        if (active) {
          count++;
          observe?.(this, method, args, result);
        }
        return result;
      },
    });
  }
  return {
    start() {
      count = 0;
      runtimeStart = statementCount();
      active = true;
    },
    stop() {
      active = false;
      // Runtime connections bind their own statement wrappers at prepare time (PM-1120).
      return runtime ? statementCount() - runtimeStart : count;
    },
    restore() {
      for (const [method, descriptor] of descriptors) Object.defineProperty(prototype, method, descriptor);
    },
  };
}
