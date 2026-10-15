import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createRepositories, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';
import { createOperatorRequestRepository } from '../src/db/operator-requests';

it('preserves old requests, step ordering and signal links while adding approval provenance', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of migrations.filter((entry) => entry.version <= 64)) db.exec(migration.sql);
    db.pragma('user_version = 64');
    // Only the repository this schema version supports; the full set prepares newer columns.
    const repos = { operatorRequests: createOperatorRequestRepository(db) };
    for (const [index, source] of ['message', 'answer', 'signal'].entries()) {
      const request = {
        id: `opr_${index}`,
        projectKey: 'AR',
        sessionId: 'ses_operator',
        source,
        messageId: 'msg_old',
        inboxItemId: 'inb_old',
        fromHandle: 'owner',
        quote: 'Old request',
        openedAt: '2026-10-14T00:00:00.000Z',
      };
      repos.operatorRequests.insert(request as Parameters<typeof repos.operatorRequests.insert>[0]);
      repos.operatorRequests.insertStep({
        id: `ops_${index}`,
        requestId: request.id,
        at: request.openedAt,
        action: 'config_change',
        status: 'awaiting_approval',
        changes: [],
        configVersion: 'old-version',
        taskKey: null,
        member: 'dev-1',
        inboxItemId: 'inb_old',
        signalId: `sig_${index}`,
        refusal: null,
      });
    }
    const requests = db.prepare('SELECT * FROM operator_requests ORDER BY rowid').all();
    const steps = db.prepare('SELECT * FROM operator_steps ORDER BY rowid').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM operator_requests ORDER BY rowid').all()).toEqual(requests);
    expect(db.prepare('SELECT * FROM operator_steps ORDER BY rowid').all()).toEqual(steps);
    const current = createRepositories(db);
    current.operatorRequests.insert({
      ...current.operatorRequests.get('opr_0')!,
      id: 'opr_approval',
      source: 'approval',
    });
    expect(current.operatorRequests.get('opr_approval')?.source).toBe('approval');
    expect(current.operatorRequests.stepsOfSignal('sig_2')).toHaveLength(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    migrate(db);
    expect(current.operatorRequests.steps('opr_0')).toHaveLength(1);
  } finally {
    db.close();
  }
});
