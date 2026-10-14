import { KeyedMutex } from './util';

/** Serializes merge decisions, fix placement and cleanup per card. Never re-enter. */
export class MergeCardLock {
  private readonly mutex = new KeyedMutex();

  run<T>(projectKey: string, taskKey: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(`${projectKey}:${taskKey}`, fn);
  }
}
