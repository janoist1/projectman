import type { QueryClient } from '@tanstack/react-query';
import type { ProjectFocusItem, ProjectFocusView } from '@projectman/shared';
import { queryKeys } from '../../api/queryKeys';

/**
 * The focus saves of one project that are on their way (PM-438). The cache holds what the server last
 * said; a save that has not come back is kept here as a change to apply on top of it, so the list shows
 * the change at once, and a refused save only drops its own change (the list "goes back") without touching
 * the result of any other save. The saves run one after the other, in the order they were made.
 */
export interface PendingChange {
  id: number;
  apply: (items: readonly ProjectFocusItem[]) => ProjectFocusItem[];
}

export class FocusSaves {
  private changes: readonly PendingChange[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  private readonly client: QueryClient;
  private readonly projectKey: string;

  constructor(client: QueryClient, projectKey: string) {
    this.client = client;
    this.projectKey = projectKey;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A new array on every change, so `useSyncExternalStore` sees it. */
  snapshot = (): readonly PendingChange[] => this.changes;

  private set(next: readonly PendingChange[]): void {
    this.changes = next;
    for (const listener of this.listeners) listener();
  }

  /**
   * Shows `apply` at once and sends `request` after the saves before it. The answer goes into the cache
   * and the change is dropped; the changes of later saves stay on top of it. A refusal drops only this
   * change and rejects.
   */
  save(apply: PendingChange['apply'], request: () => Promise<ProjectFocusView>): Promise<void> {
    const change: PendingChange = { id: this.nextId++, apply };
    this.set([...this.changes, change]);
    const run = async () => {
      try {
        const view = await request();
        this.client.setQueryData<ProjectFocusView>(queryKeys.focus(this.projectKey), view);
        // The server's event does this too; a write must not wait for a socket that may be down.
        void this.client.invalidateQueries({ queryKey: queryKeys.focusChanges(this.projectKey) });
      } finally {
        this.set(this.changes.filter((entry) => entry.id !== change.id));
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const stores = new WeakMap<QueryClient, Map<string, FocusSaves>>();

export function savesFor(client: QueryClient, projectKey: string): FocusSaves {
  let byProject = stores.get(client);
  if (!byProject) {
    byProject = new Map();
    stores.set(client, byProject);
  }
  let saves = byProject.get(projectKey);
  if (!saves) {
    saves = new FocusSaves(client, projectKey);
    byProject.set(projectKey, saves);
  }
  return saves;
}
