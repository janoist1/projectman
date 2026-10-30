import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { operatorApprovalOf } from '@projectman/shared';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

const approval = (requestId: string, stepId: string) =>
  JSON.stringify({
    operator: {
      requestId,
      stepId,
      quote: 'Rename the project.',
      action: 'config_change',
      operation: { op: 'config_patch', patch: {} },
      changes: [],
      consequence: 'project',
      baseVersion: 'v1',
      session: null,
      stale: null,
    },
  });

/** PM-1158: the dead Operator approval path is closed in the database; the old rows keep rendering. */
describe('Operator approval removal migration', () => {
  it('cancels open approvals, settles unfinished steps and executions, and leaves the rest alone', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version <= 133)) db.exec(migration.sql);
      db.pragma('user_version = 133');
      const knowledgePayload = JSON.stringify({ operatorKnowledge: { id: 'okp_1', stepId: 'ops_know' } });
      db.exec(`INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at)
        VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO inbox_items (id, project_key, kind, assignees, source, title, payload, options, state, created_at, updated_at)
        VALUES ('inb_open', 'AR', 'approval', '["owner"]', 'pm', 'Open', '${approval('opr_1', 'ops_open')}', '[]', 'open', '2026-01-01', '2026-01-01'),
          ('inb_done', 'AR', 'approval', '["owner"]', 'pm', 'Done', '${approval('opr_1', 'ops_done')}', '[]', 'resolved', '2026-01-01', '2026-01-01'),
          ('inb_know', 'AR', 'approval', '["owner"]', 'pm', 'Knowledge', '${knowledgePayload}', '[]', 'open', '2026-01-01', '2026-01-01');
        INSERT INTO operator_requests (id, project_key, session_id, source, message_id, inbox_item_id, from_handle, quote, opened_at)
        VALUES ('opr_1', 'AR', 'ses_1', 'message', NULL, NULL, 'owner', 'q', '2026-01-01');
        INSERT INTO operator_steps (id, request_id, at, action, status, inbox_item_id)
        VALUES ('ops_open', 'opr_1', '2026-01-01', 'config_patch', 'awaiting_approval', 'inb_open'),
          ('ops_done', 'opr_1', '2026-01-01', 'config_patch', 'approved', 'inb_done'),
          ('ops_know', 'opr_1', '2026-01-01', 'knowledge_change', 'awaiting_approval', 'inb_know'),
          ('ops_prepared', 'opr_1', '2026-01-01', 'config_patch', 'queued', NULL);
        INSERT INTO operator_execution_intents (id, project_key, request_id, operation, changes, agreement_version, approval_mode, status, created_at, updated_at)
        VALUES ('ops_prepared', 'AR', 'opr_1', '{"op":"config_patch","patch":{}}', '[]', NULL, 'click', 'prepared', '2026-01-01', '2026-01-01'),
          ('ops_done', 'AR', 'opr_1', '{"op":"config_patch","patch":{}}', '[]', NULL, 'click', 'committed', '2026-01-01', '2026-01-01');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.inbox.get('inb_open')).toMatchObject({ state: 'cancelled' });
      // The closed approval still reads as an Operator approval; the open knowledge proposal is untouched.
      expect(repos.inbox.get('inb_done')).toMatchObject({ state: 'resolved' });
      expect(operatorApprovalOf(repos.inbox.get('inb_done')!)).toMatchObject({ requestId: 'opr_1' });
      expect(repos.inbox.get('inb_know')).toMatchObject({ state: 'open' });
      const steps = Object.fromEntries(repos.operatorRequests.steps('opr_1').map((step) => [step.id, step]));
      expect(steps.ops_open).toMatchObject({ status: 'stale' });
      expect(steps.ops_done).toMatchObject({ status: 'approved' });
      expect(steps.ops_know).toMatchObject({ status: 'awaiting_approval' });
      expect(steps.ops_prepared).toMatchObject({
        status: 'refused',
        refusal: { code: 'operator_no_request' },
      });
      const executions = Object.fromEntries(
        repos.operatorRequests.executions('AR').map((entry) => [entry.id, entry]),
      );
      expect(executions.ops_prepared).toMatchObject({
        status: 'failed',
        refusal: { code: 'operator_no_request' },
      });
      expect(executions.ops_done).toMatchObject({ status: 'committed' });
    } finally {
      db.close();
    }
  });
});
