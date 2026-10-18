import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import { humanActor } from '../src/kernel';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

type Mode = 'legacy' | 'super' | 'read';

interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, any>;
  isError?: boolean;
}

/** The Operator tools the super mode got on the bearer endpoint (PM-784). */
describe('the bearer MCP endpoint: the Operator tools (PM-784)', () => {
  let h: AppHarness;
  let cookie: string;
  let now: Date;
  let nextId = 1;

  beforeEach(async () => {
    now = new Date('2026-10-18T10:00:00.000Z');
    h = await createAppHarness({ now: () => now, real: { mcp: true } });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  function key(mode: Mode) {
    const { auth, repos } = h.app.projectman;
    const user = repos.users.list()[0]!;
    if (mode === 'legacy') return { secret: auth.createIntegratorKey(user.id, null).secret, id: '' };
    const created = auth.createIntegratorAccessKey(user.id, { mode, expiresInDays: 7 });
    return { secret: created.secret, id: created.key.id };
  }

  async function call(secret: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const response = await h.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${secret}`,
      },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().result;
  }

  const code = (result: ToolResult) => result.structuredContent?.errorCode;
  const audit = () => h.app.projectman.repos.superAudit.list('AR', { limit: 100 }).entries;
  const inboxItems = () => h.app.projectman.domain.inbox.list('AR');

  describe('ask_human, get_super_question and withdraw_question', () => {
    it('opens an owner question without a session, reads it and withdraws it', async () => {
      const { secret } = key('super');
      const asked = await call(secret, 'ask_human', {
        project_key: 'AR',
        question: 'Roll the migration out tonight?',
        options: ['Tonight', 'Tomorrow'],
        recommended: 'Tomorrow',
        recommendation_reason: 'Fewer users are online in the morning.',
      });
      expect(asked.isError, JSON.stringify(asked)).not.toBe(true);
      expect(asked.structuredContent).toMatchObject({ state: 'open', attachments: [] });
      const itemId = asked.structuredContent!.inbox_item_id as string;

      const item = inboxItems().find((candidate) => candidate.id === itemId)!;
      expect(item.state).toBe('open');
      // Nobody is woken and no screening or integrator todo is made for it.
      expect(JSON.stringify(item.payload)).not.toContain('"todo"');

      const read = await call(secret, 'get_super_question', { project_key: 'AR', item_id: itemId });
      expect(read.structuredContent).toMatchObject({ item: { id: itemId, state: 'open' }, answer: null });
      // A read key sees the same question (a reader), but may not ask or withdraw.
      const readKey = key('read');
      const readRead = await call(readKey.secret, 'get_super_question', {
        project_key: 'AR',
        item_id: itemId,
      });
      expect(readRead.structuredContent?.item.id).toBe(itemId);
      expect(
        code(
          await call(readKey.secret, 'withdraw_question', {
            project_key: 'AR',
            item_id: itemId,
            reason: 'no',
          }),
        ),
      ).toMatch(/integrator_not_allowed|integrator_read_only/);

      const withdrawn = await call(secret, 'withdraw_question', {
        project_key: 'AR',
        item_id: itemId,
        reason: 'Settled in the call.',
      });
      expect(withdrawn.structuredContent).toEqual({ item_id: itemId, state: 'cancelled' });
      const after = await call(secret, 'get_super_question', { project_key: 'AR', item_id: itemId });
      expect(after.structuredContent).toMatchObject({ item: { state: 'cancelled' }, answer: null });
    });

    it('refuses the token a relay or an answer, and leaves the answer to the owner’s own login', async () => {
      const { secret } = key('super');
      const information = await call(secret, 'ask_human', {
        project_key: 'AR',
        question: 'Which port does staging use?',
        response_purpose: 'information',
      });
      const decision = await call(secret, 'ask_human', {
        project_key: 'AR',
        question: 'Delete the old branch?',
        options: ['Delete', 'Keep'],
      });
      const infoId = information.structuredContent!.inbox_item_id as string;
      const decisionId = decision.structuredContent!.inbox_item_id as string;

      const relayed = await call(secret, 'relay_owner_answer', {
        project_key: 'AR',
        item_id: infoId,
        answer: 'The owner said 4100.',
      });
      expect(code(relayed)).toBe('super_relay_refused');
      expect(inboxItems().find((item) => item.id === infoId)!.state).toBe('open');

      const owner = await inject(h.app, 'POST', routes.resolveInbox('AR', decisionId), cookie, {
        optionId: 'option_2',
      });
      expect(owner.statusCode, owner.body).toBe(200);
      const answered = await call(secret, 'get_super_question', { project_key: 'AR', item_id: decisionId });
      expect(answered.structuredContent).toMatchObject({ item: { state: 'resolved' } });
      expect(answered.structuredContent!.answer).not.toBeNull();
      // Once answered, a question can no longer be withdrawn.
      expect(
        code(
          await call(secret, 'withdraw_question', { project_key: 'AR', item_id: decisionId, reason: 'late' }),
        ),
      ).toBe('inbox_item_closed');
    });

    it('lists the files of the owner’s own answer, and keeps listing them', async () => {
      const { secret } = key('super');
      const asked = await call(secret, 'ask_human', {
        project_key: 'AR',
        question: 'Which layout?',
        options: ['First', 'Second'],
      });
      const itemId = asked.structuredContent!.inbox_item_id as string;
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
      ]);
      const file = await h.app.projectman.domain.messageAttachments.upload({
        projectKey: 'AR',
        actor: humanActor('owner'),
        fileName: 'layout.png',
        content: Readable.from([png]),
      });
      const open = await call(secret, 'get_super_question', { project_key: 'AR', item_id: itemId });
      expect(open.structuredContent).toMatchObject({ answer: null, answer_attachments: [] });

      await h.app.projectman.domain.inbox.resolve(
        'AR',
        itemId,
        { optionId: 'option_2', attachmentIds: [file.id] },
        { handle: 'owner', access: 'owner' },
      );
      // The answer is stored with the question, so it reads the same on every later call.
      for (const mode of ['super', 'read'] as const) {
        const answered = await call(key(mode).secret, 'get_super_question', {
          project_key: 'AR',
          item_id: itemId,
        });
        expect(answered.structuredContent).toMatchObject({
          item: { state: 'resolved' },
          answer_attachments: [{ id: file.id, fileName: 'layout.png' }],
        });
        expect(answered.structuredContent!.answer).not.toBeNull();
      }
    });

    it('shows a question only to the key owner who asked it and in its own project', async () => {
      const { secret } = key('super');
      const asked = await call(secret, 'ask_human', { project_key: 'AR', question: 'Is this mine?' });
      const itemId = asked.structuredContent!.inbox_item_id as string;
      expect(
        code(await call(secret, 'get_super_question', { project_key: 'AR', item_id: 'inb_nothing' })),
      ).toBe('not_found');
      // A question of a member, not of the integrator, is not visible through this reader.
      const member = h.app.projectman.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source: 'dev-1',
        assignees: ['owner'],
        title: 'Member question',
        payload: { question: 'Member question', recipient: 'owner' },
        options: [{ id: 'option_1', label: 'Yes', style: 'primary' }],
      });
      expect(code(await call(secret, 'get_super_question', { project_key: 'AR', item_id: member.id }))).toBe(
        'not_found',
      );
      expect(code(await call(secret, 'get_super_question', { project_key: 'ZZ', item_id: itemId }))).toBe(
        'insufficient_access',
      );
    });

    it('rejects a bad or extra argument and the member-only parameters', async () => {
      const { secret } = key('super');
      for (const extra of [
        { recipient: 'owner' },
        { reask_of: 'inb_x' },
        { reask_reason: 'again' },
        { nope: 1 },
      ])
        expect(
          code(await call(secret, 'ask_human', { project_key: 'AR', question: 'Hi?', ...extra })),
          JSON.stringify(extra),
        ).toBe('invalid_request');
      expect(code(await call(secret, 'ask_human', { project_key: 'AR' }))).toBe('invalid_request');
      expect(
        code(await call(secret, 'ask_human', { project_key: 'AR', question: 'Hi?', to: ['nobody'] })),
      ).toBe('invalid_request');
      expect(inboxItems().filter((item) => item.kind === 'question')).toEqual([]);
    });

    it('audits the question without its text', async () => {
      const { secret } = key('super');
      await call(secret, 'ask_human', { project_key: 'AR', question: 'A confidential question text?' });
      const entries = audit().filter((entry) => entry.operation === 'mcp_ask_human');
      expect(entries.map((entry) => entry.outcome)).toEqual(expect.arrayContaining(['started', 'succeeded']));
      expect(JSON.stringify(entries)).not.toContain('confidential');
    });
  });

  describe('the documents, the role configuration, the release and the review', () => {
    it('reads the role configuration in the super and read modes and never in the legacy mode', async () => {
      const superRead = await call(key('super').secret, 'get_role_configuration', {
        project_key: 'AR',
        role: 'developer',
      });
      expect(superRead.isError, JSON.stringify(superRead)).not.toBe(true);
      expect(superRead.structuredContent).toMatchObject({ role: 'developer' });
      expect(superRead.structuredContent).toHaveProperty('effective');
      const readRead = await call(key('read').secret, 'get_role_configuration', {
        project_key: 'AR',
        role: 'developer',
      });
      expect(readRead.structuredContent).toMatchObject({ role: 'developer' });
      expect(
        code(
          await call(key('legacy').secret, 'get_role_configuration', {
            project_key: 'AR',
            role: 'developer',
          }),
        ),
      ).toBe('integrator_not_allowed');
      expect(
        code(
          await call(key('super').secret, 'get_role_configuration', {
            project_key: 'AR',
            role: 'no_such_role',
          }),
        ),
      ).toBe('invalid_request');
    });

    it('validates the document tools’ arguments before anything runs', async () => {
      const { secret } = key('super');
      const base = { project_key: 'AR' };
      expect(code(await call(secret, 'read_project_doc', { ...base, doc: 'SECRETS' }))).toBe(
        'invalid_request',
      );
      expect(code(await call(secret, 'read_project_doc', { ...base, doc: 'ROADMAP', from_line: 0 }))).toBe(
        'invalid_request',
      );
      expect(
        code(await call(secret, 'read_project_doc', { ...base, doc: 'ROADMAP', line_count: 2001 })),
      ).toBe('invalid_request');
      const write = { ...base, base_commit: 'a'.repeat(40), message: 'Update', edits: [] as unknown[] };
      expect(code(await call(secret, 'write_project_docs', write))).toBe('invalid_request');
      expect(
        code(
          await call(secret, 'write_project_docs', {
            ...write,
            base_commit: 'xyz',
            edits: [{ doc: 'ROADMAP', old_text: '', new_text: 'x' }],
          }),
        ),
      ).toBe('invalid_request');
      expect(
        code(
          await call(secret, 'write_project_docs', {
            ...write,
            message: 'two\nlines',
            edits: [{ doc: 'ROADMAP', old_text: '', new_text: 'x' }],
          }),
        ),
      ).toBe('invalid_request');
      expect(code(await call(secret, 'get_project_doc_write', { ...base, write_id: '' }))).toBe(
        'invalid_request',
      );
      expect(code(await call(secret, 'get_project_doc_write', { ...base, write_id: 'dwr_missing' }))).toBe(
        'not_found',
      );
    });

    it('keeps the document writers from a read key and from a legacy key', async () => {
      const args = {
        project_key: 'AR',
        base_commit: 'a'.repeat(40),
        message: 'Update',
        edits: [{ doc: 'ROADMAP', old_text: '', new_text: 'x' }],
      };
      expect(code(await call(key('read').secret, 'write_project_docs', args))).toBe('integrator_read_only');
      expect(code(await call(key('legacy').secret, 'write_project_docs', args))).toBe(
        'integrator_not_allowed',
      );
      expect(
        code(await call(key('legacy').secret, 'read_project_doc', { project_key: 'AR', doc: 'ROADMAP' })),
      ).toBe('integrator_not_allowed');
    });

    it('validates the release proposal and the review request', async () => {
      const { secret } = key('super');
      expect(
        code(await call(secret, 'propose_release', { project_key: 'AR', title: '', summary: 'x' })),
      ).toBe('invalid_request');
      expect(
        code(
          await call(secret, 'propose_release', {
            project_key: 'AR',
            title: 'T',
            summary: 'S',
            commit: 'zz',
          }),
        ),
      ).toBe('invalid_request');
      expect(
        code(await call(secret, 'request_structural_review', { project_key: 'AR', signal_id: 'x' })),
      ).toBe('invalid_request');
      expect(
        code(
          await call(secret, 'request_structural_review', {
            project_key: 'AR',
            signal_id: 'sig_missing',
            note: 'Please look.',
          }),
        ),
      ).toMatch(/invalid_request|not_found|operator_signal_closed/);
      for (const name of ['propose_release', 'request_structural_review']) {
        expect(
          code(await call(key('read').secret, name, { project_key: 'AR', title: 'T', summary: 'S' })),
          name,
        ).toMatch(/integrator_not_allowed|integrator_read_only/);
      }
    });
  });

  describe('read_attachment', () => {
    it('validates its arguments and refuses the legacy mode', async () => {
      const { secret } = key('super');
      const base = { project_key: 'AR', task_key: 'AR-1', attachment_id: 'att_none' };
      expect(code(await call(secret, 'read_attachment', { ...base, offset_bytes: -1 }))).toBe(
        'invalid_request',
      );
      expect(code(await call(secret, 'read_attachment', { ...base, max_bytes: 0 }))).toBe('invalid_request');
      expect(code(await call(secret, 'read_attachment', { ...base, max_bytes: 1_048_577 }))).toBe(
        'invalid_request',
      );
      expect(code(await call(secret, 'read_attachment', { ...base, path: '/etc/passwd' }))).toBe(
        'invalid_request',
      );
      expect(code(await call(key('legacy').secret, 'read_attachment', base))).toBe('integrator_not_allowed');
    });

    /** A PNG-looking file whose bytes all differ by position, so a wrong offset or a re-encoding shows. */
    const patterned = (size: number) =>
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(Array.from({ length: size - 8 }, (_, i) => (i * 7 + 3) % 256)),
      ]);
    const upload = (taskKey: string, content: Buffer, fileName = 'shot.png') =>
      h.app.projectman.domain.attachments.upload({
        projectKey: 'AR',
        taskKey,
        actor: humanActor('owner'),
        fileName,
        content: Readable.from([content]),
      });
    const readChunk = (secret: string, args: Record<string, unknown>) =>
      call(secret, 'read_attachment', { project_key: 'AR', ...args });

    it('reads the file byte-exact in chunks with the super and the read key, and ends at the last byte', async () => {
      const owner = humanActor('owner');
      await h.app.projectman.domain.tasks.create('AR', { title: 'Card' }, owner);
      const bytes = patterned(1000);
      const attachment = await upload('AR-1', bytes);
      for (const mode of ['super', 'read'] as const) {
        const { secret } = key(mode);
        const parts: Buffer[] = [];
        let offset = 0;
        let calls = 0;
        for (;;) {
          calls += 1;
          const result = await readChunk(secret, {
            task_key: 'AR-1',
            attachment_id: attachment.id,
            offset_bytes: offset,
            max_bytes: 400,
          });
          expect(result.isError, mode).toBeFalsy();
          const read = result.structuredContent!;
          expect(JSON.parse(result.content[0]!.text!)).toEqual(read);
          expect(read.attachment).toMatchObject({ id: attachment.id, size: 1000, fileName: 'shot.png' });
          expect(read.content).toMatchObject({ encoding: 'base64', offset_bytes: offset, total_bytes: 1000 });
          const data = Buffer.from(read.content.data, 'base64');
          expect(data.length).toBe(read.content.byte_length);
          parts.push(data);
          offset += data.length;
          if (read.content.next_offset === null) break;
          expect(read.content.next_offset).toBe(offset);
        }
        expect(calls, mode).toBe(3);
        expect(Buffer.concat(parts).equals(bytes), mode).toBe(true);
        expect(offset).toBe(1000);
      }
    });

    it('defaults to the whole small file, allows the end offset and refuses one past it', async () => {
      await h.app.projectman.domain.tasks.create('AR', { title: 'Card' }, humanActor('owner'));
      const bytes = patterned(300);
      const attachment = await upload('AR-1', bytes);
      const { secret } = key('super');
      const whole = await readChunk(secret, { task_key: 'AR-1', attachment_id: attachment.id });
      expect(Buffer.from(whole.structuredContent!.content.data, 'base64').equals(bytes)).toBe(true);
      expect(whole.structuredContent!.content).toMatchObject({
        offset_bytes: 0,
        byte_length: 300,
        total_bytes: 300,
        next_offset: null,
      });
      const end = await readChunk(secret, {
        task_key: 'AR-1',
        attachment_id: attachment.id,
        offset_bytes: 300,
      });
      expect(end.structuredContent!.content).toMatchObject({
        data: '',
        byte_length: 0,
        total_bytes: 300,
        next_offset: null,
      });
      const past = await readChunk(secret, {
        task_key: 'AR-1',
        attachment_id: attachment.id,
        offset_bytes: 301,
      });
      expect(code(past)).toBe('invalid_request');
      const middle = await readChunk(secret, {
        task_key: 'AR-1',
        attachment_id: attachment.id,
        offset_bytes: 299,
        max_bytes: 10,
      });
      expect(Buffer.from(middle.structuredContent!.content.data, 'base64').equals(bytes.subarray(299))).toBe(
        true,
      );
    });

    it('finds a file only on the card that holds it and hides a deleted one', async () => {
      const owner = humanActor('owner');
      const { domain } = h.app.projectman;
      await domain.tasks.create('AR', { title: 'Parent' }, owner);
      await domain.tasks.create('AR', { title: 'Child', parentKey: 'AR-1' }, owner);
      await domain.tasks.create('AR', { title: 'Other' }, owner);
      const parentFile = await upload('AR-1', patterned(200), 'parent.png');
      const otherFile = await upload('AR-3', patterned(200), 'other.png');
      const { secret } = key('super');
      expect(
        (await readChunk(secret, { task_key: 'AR-1', attachment_id: parentFile.id })).isError,
      ).toBeFalsy();
      // The file of the parent needs the parent's key, and a file of another card is not found.
      expect(code(await readChunk(secret, { task_key: 'AR-2', attachment_id: parentFile.id }))).toBe(
        'not_found',
      );
      expect(code(await readChunk(secret, { task_key: 'AR-1', attachment_id: otherFile.id }))).toBe(
        'not_found',
      );
      expect(code(await readChunk(secret, { task_key: 'AR-9', attachment_id: otherFile.id }))).toBe(
        'not_found',
      );
      await domain.attachments.delete('AR', 'AR-3', otherFile.id, owner);
      expect(code(await readChunk(secret, { task_key: 'AR-3', attachment_id: otherFile.id }))).toBe(
        'not_found',
      );
    });

    it('checks the key and the project on every chunk', async () => {
      await h.app.projectman.domain.tasks.create('AR', { title: 'Card' }, humanActor('owner'));
      const attachment = await upload('AR-1', patterned(300));
      const { secret, id } = key('super');
      const args = { task_key: 'AR-1', attachment_id: attachment.id, max_bytes: 100 };
      expect((await readChunk(secret, args)).isError).toBeFalsy();
      expect(code(await call(secret, 'read_attachment', { ...args, project_key: 'ZZ' }))).toBe(
        'insufficient_access',
      );
      h.app.projectman.auth.revokeIntegratorAccessKey(h.app.projectman.repos.users.list()[0]!.id, id);
      const revoked = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${secret}`,
        },
        payload: JSON.stringify({
          jsonrpc: '2.0',
          id: nextId++,
          method: 'tools/call',
          params: { name: 'read_attachment', arguments: { project_key: 'AR', ...args, offset_bytes: 100 } },
        }),
      });
      expect(revoked.statusCode).toBe(401);
    });

    it('refuses a file over the size limit before it reads anything', async () => {
      await h.app.projectman.domain.tasks.create('AR', { title: 'Card' }, humanActor('owner'));
      const attachment = await upload('AR-1', patterned(300));
      const attachments = h.app.projectman.domain.attachments;
      const open = attachments.open.bind(attachments);
      vi.spyOn(attachments, 'open').mockImplementation(async (...args) => {
        const opened = await open(...args);
        return { ...opened, attachment: { ...opened.attachment, size: 25 * 1_048_576 + 1 } };
      });
      const { secret } = key('super');
      const refused = await readChunk(secret, { task_key: 'AR-1', attachment_id: attachment.id });
      expect(code(refused)).toBe('invalid_request');
      expect(JSON.stringify(refused)).toContain('larger than');
      // The limit is the recorded size: the file itself is untouched and a normal read still works.
      vi.restoreAllMocks();
      expect(
        (await readChunk(secret, { task_key: 'AR-1', attachment_id: attachment.id })).isError,
      ).toBeFalsy();
    });
  });
});
