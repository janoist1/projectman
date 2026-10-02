import { describe, expect, it } from 'vitest';
import type { BoardView, Session } from '@projectman/shared';
import { indexPipeline } from '../lib/pipeline';
import { t } from '../i18n/t';
import { indexMembers } from '../lib/members';
import { deriveTaskState, groupOpenInboxByTask } from '../lib/taskState';
import { MockBackend } from './backend';
import { minutesAgo } from './time';

const base = '/api/projects/AC';

function sessionOn(taskKey: string, patch: Partial<Session>): Session {
  return {
    id: `ses_${taskKey}`,
    projectKey: 'AC',
    member: 'be-1',
    workItem: { type: 'task', taskKey },
    claudeSessionId: '00000000-0000-4000-8000-000000000001',
    cwd: '/tmp/work',
    branch: null,
    transcriptPath: null,
    state: 'idle',
    activity: null,
    startedAt: minutesAgo(60),
    lastActivityAt: minutesAgo(30),
    endedAt: null,
    ...patch,
  };
}

/** The state of a card as the board derives it from what the fake backend serves. */
function stateOf(backend: MockBackend, taskKey: string) {
  const board = backend.handle('GET', `${base}/board`, undefined).body as BoardView;
  const task = board.tasks.find((entry) => entry.key === taskKey)!;
  return deriveTaskState(task, {
    pipeline: indexPipeline(board),
    members: indexMembers(board.members),
    openInboxByTask: groupOpenInboxByTask([]),
    tasksByKey: new Map(board.tasks.map((entry) => [entry.key, entry])),
    myHandle: 'owner',
  });
}

describe('a card is "working" only where its own session works (PM-207)', () => {
  it('does not show a member who works on another card as working on the one where they rest', () => {
    const backend = new MockBackend();
    backend.sessions = [
      sessionOn('AC-20', { state: 'working', activity: 'Bash: restore drill', stateSince: minutesAgo(3) }),
      sessionOn('AC-26', { state: 'idle', stateSince: minutesAgo(25) }),
    ];
    const be = backend.findMember('be-1')!;
    be.status = 'working';
    be.activity = 'Bash: restore drill';
    be.currentTaskKeys = ['AC-20', 'AC-26'];

    const working = stateOf(backend, 'AC-20');
    expect(working.phase).toBe('working');
    expect(working.label).toBe(t('taskStatus.worker.working', { name: be.displayName }));
    expect(working.label).not.toContain('Bash');
    expect(working.since).toBe(backend.sessions[0]!.stateSince);

    const resting = stateOf(backend, 'AC-26');
    expect(resting.phase).not.toBe('working');
    expect(resting.worker).toBeNull();
    expect(resting.label).not.toContain('Bash: restore drill');
  });
});
