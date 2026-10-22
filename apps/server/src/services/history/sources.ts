import type { HistoryDocumentRow, Repositories } from '../../db';
import type { HistoryRelated, HistorySourceState, HistorySourceType, Task } from '@projectman/shared';

/** The repositories the history reads its sources through (the current project, never an index copy). */
export type HistorySourceRepos = Pick<
  Repositories,
  'history' | 'historySearches' | 'tasks' | 'timeline' | 'inbox' | 'messages'
>;

/** A time in UTC ISO 8601 with milliseconds, so that the filter and the order of the index compare as text. */
export function normalizeAt(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** A source as it is now, with the time its stored copy keeps when it has none of its own; null when it is gone. */
interface LoadedHistorySource {
  source: HistorySourceState;
  storedAt: string;
}

/** The card of a project by key; a card of another project is none. */
export function taskOfProject(repos: HistorySourceRepos, projectKey: string, key: string): Task | null {
  const task = repos.tasks.get(key);
  return task && task.projectKey === projectKey ? task : null;
}

/** Reads one source of the project from its table. A document is no table source: it is stored whole. */
export function loadHistorySource(
  repos: HistorySourceRepos,
  projectKey: string,
  type: Exclude<HistorySourceType, 'document'>,
  entityId: string,
): LoadedHistorySource | null {
  switch (type) {
    case 'task': {
      const key = repos.history.taskKeyOfId(entityId);
      const task = key === null ? null : taskOfProject(repos, projectKey, key);
      return task && task.id === entityId ? { source: { type, task }, storedAt: task.updatedAt } : null;
    }
    case 'note': {
      const event = repos.timeline.get(projectKey, entityId);
      if (!event || event.type !== 'task_note' || event.taskKey === null) return null;
      const task = taskOfProject(repos, projectKey, event.taskKey);
      return task ? { source: { type, task, event }, storedAt: event.createdAt } : null;
    }
    case 'question': {
      const item = repos.inbox.get(entityId);
      if (!item || item.projectKey !== projectKey) return null;
      return { source: { type, item }, storedAt: repos.history.inboxUpdatedAt(entityId) ?? item.createdAt };
    }
    case 'message': {
      const message = repos.messages.get(entityId);
      if (!message || message.projectKey !== projectKey) return null;
      return { source: { type, message }, storedAt: message.createdAt };
    }
  }
}

/** The source behind a stored row as it is now; a document is its stored copy. */
export function loadRowSource(repos: HistorySourceRepos, row: HistoryDocumentRow): HistorySourceState | null {
  if (row.sourceType === 'document') {
    return row.repo && row.path && row.commitSha
      ? { type: 'document', repo: row.repo, path: row.path, commit: row.commitSha, text: row.body }
      : null;
  }
  return loadHistorySource(repos, row.projectKey, row.sourceType, row.entityId)?.source ?? null;
}

/** The current records the visibility rule follows from a source; one search shares the cards it has read. */
export function relatedOf(repos: HistorySourceRepos, projectKey: string): HistoryRelated {
  const tasks = new Map<string, Task | null>();
  return {
    taskOf: (key) => {
      if (!tasks.has(key)) tasks.set(key, taskOfProject(repos, projectKey, key));
      return tasks.get(key) ?? null;
    },
    eventOf: (id) => repos.timeline.get(projectKey, id),
    inboxOf: (id) => {
      const item = repos.inbox.get(id);
      return item && item.projectKey === projectKey ? item : null;
    },
  };
}
