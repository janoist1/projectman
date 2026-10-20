import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createRepositories, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

it.each([64, 68])('preserves requests, steps and signal links when migrating schema %i', (version) => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of migrations.filter((entry) => entry.version <= version)) db.exec(migration.sql);
    db.pragma(`user_version = ${version}`);
    // Historical fixtures use their schema's columns, independent of the current repository.
    const insertRequest = db.prepare(`INSERT INTO operator_requests
      (id, project_key, session_id, source, message_id, inbox_item_id, from_handle, quote, opened_at)
      VALUES (@id, @projectKey, @sessionId, @source, @messageId, @inboxItemId, @fromHandle, @quote, @openedAt)`);
    const insertStep = db.prepare(`INSERT INTO operator_steps
      (id, request_id, at, action, status, changes, config_version, task_key, member, inbox_item_id, signal_id, refusal)
      VALUES (@id, @requestId, @at, @action, @status, @changes, @configVersion, @taskKey, @member, @inboxItemId, @signalId, @refusal)`);
    const sources = ['message', 'answer', 'signal', ...(version >= 65 ? ['approval'] : [])];
    for (const [index, source] of sources.entries()) {
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
      insertRequest.run(request);
      insertStep.run({
        id: `ops_${index}`,
        requestId: request.id,
        at: request.openedAt,
        action: 'config_change',
        status: 'awaiting_approval',
        changes: JSON.stringify([
          { area: 'project', target: null, field: 'name', before: 'Old', after: 'New', level: 'approval' },
        ]),
        configVersion: 'old-version',
        taskKey: null,
        member: 'dev-1',
        inboxItemId: 'inb_old',
        signalId: `sig_${index}`,
        refusal: null,
      });
    }
    const requests = db.prepare('SELECT * FROM operator_requests ORDER BY rowid').all();
    const steps = db.prepare('SELECT * FROM operator_steps ORDER BY rowid').all() as Record<
      string,
      unknown
    >[];
    migrate(db);
    expect(db.prepare('SELECT * FROM operator_requests ORDER BY rowid').all()).toEqual(requests);
    expect(db.prepare('SELECT * FROM operator_steps ORDER BY rowid').all()).toEqual(
      steps.map((step) => ({
        ...step,
        agreement_version: null,
        approval_mode: null,
        operation_id: null,
      })),
    );
    const current = createRepositories(db);
    expect(current.operatorRequests.executions('AR')).toEqual([]);
    for (const index of sources.keys()) {
      expect(current.operatorRequests.steps(`opr_${index}`)).toMatchObject([
        {
          id: `ops_${index}`,
          status: 'awaiting_approval',
          configVersion: 'old-version',
          signalId: `sig_${index}`,
          agreementVersion: null,
          approvalMode: null,
          changes: [
            { area: 'project', target: null, field: 'name', before: 'Old', after: 'New', level: 'approval' },
          ],
        },
      ]);
    }
    current.operatorRequests.insert({
      ...current.operatorRequests.get('opr_0')!,
      id: 'opr_new_approval',
      source: 'approval',
    });
    expect(current.operatorRequests.get('opr_new_approval')?.source).toBe('approval');
    expect(current.operatorRequests.stepsOfSignal('sig_2')).toHaveLength(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    migrate(db);
    expect(current.operatorRequests.steps('opr_0')).toHaveLength(1);
  } finally {
    db.close();
  }
});
