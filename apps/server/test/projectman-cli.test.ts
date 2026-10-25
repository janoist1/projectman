import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_CHANNEL_HEADER, CLIENT_CHANNEL_VALUE, CLIENT_EXIT } from '@projectman/shared';
import { main, usageText } from '../../../scripts/projectman/cli';
import { COMMANDS } from '../../../scripts/projectman/commands';
import { ApiError, createApiClient } from '../../../scripts/projectman/http';
import { loadCredentials } from '../../../scripts/projectman/config';
import {
  CANARY_ACCESS_ID,
  CANARY_ACCESS_SECRET,
  CANARY_KEY,
  createClientHome,
  createTestIo,
  jsonResponse,
  type ClientHome,
  type Handler,
  type Recorded,
  type TestIoOptions,
} from './helpers/projectman-client';

const SECRETS = [CANARY_KEY, CANARY_ACCESS_ID, CANARY_ACCESS_SECRET];
const REQUEST_1 = '00000000-0000-4000-8000-000000000001';

const operationBody = (command: unknown, requestId = REQUEST_1) => ({
  operation: {
    id: 'sop_1',
    projectKey: 'PM',
    taskKey: null,
    handoffId: null,
    state: 'succeeded',
    requestId,
    command,
    ownerQuestionId: null,
    errorCode: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
  },
});

describe('projectman CLI (PM-765)', () => {
  let fx: ClientHome;
  beforeEach(() => {
    fx = createClientHome({ access: true });
  });
  afterEach(() => fx.cleanup());

  const run = async (args: string[], handler: Handler, options: TestIoOptions = {}) => {
    const t = createTestIo(fx.home, handler, options);
    const code = await main(args, t.io);
    return { code, ...t };
  };
  const accepted: Handler = () => jsonResponse({ accepted: true }, 201);
  const fileOf = (name: string, text: string): string => {
    const file = path.join(fx.home, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const bodyOf = (request: Recorded | undefined): unknown => JSON.parse(request?.body ?? 'null');

  describe('arguments and exit codes', () => {
    it('prints the usage without a request: 2 for no command, 0 for --help', async () => {
      const none = await run([], accepted);
      expect(none.code).toBe(CLIENT_EXIT.usage);
      expect(none.stderr.join('')).toContain('usage: projectman');
      const help = await run(['--help'], accepted);
      expect(help.code).toBe(CLIENT_EXIT.ok);
      expect(help.stdout).toEqual([]);
      const text = usageText();
      for (const command of COMMANDS) expect(text).toContain(command.usage);
      expect(text).toContain('mcp-proxy');
      expect(none.requests.length + help.requests.length).toBe(0);
    });

    it('a wrong argument is a usage error (2) even when the configuration is wrong too', async () => {
      fs.chmodSync(fx.keyFile, 0o644);
      const wrongArgument = await run(['inbox', 'list'], accepted);
      expect(wrongArgument.code).toBe(CLIENT_EXIT.usage);
      const rightArgument = await run(['inbox', 'list', '--project', 'PM'], accepted);
      expect(rightArgument.code).toBe(CLIENT_EXIT.auth);
      expect(rightArgument.requests).toEqual([]);
    });

    it('--file - ends on the signal while standard input is open and silent', async () => {
      const stdin: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<string>>(() => undefined),
          return: async () => ({ done: true, value: undefined }),
        }),
      };
      const t = createTestIo(fx.home, accepted, { stdin });
      const finished = main(['tasks', 'create', '--project', 'PM', '--file', '-'], t.io);
      setTimeout(() => t.controller.abort(), 10);
      expect(await finished).toBe(CLIENT_EXIT.ok);
      expect(t.requests).toEqual([]);
    });

    it.each([
      [['nonsense']],
      [['tasks']],
      [['tasks', 'create']],
      [['tasks', 'create', '--project', 'pm', '--file', 'x']],
      [['tasks', 'create', '--project', 'PM']],
      [['tasks', 'start']],
      [['tasks', 'start', 'nope']],
      [['tasks', 'start', 'PM-1', 'PM-2']],
      [['tasks', 'start', 'PM-1', '--project', 'XY']],
      [['tasks', 'start', 'PM-1', '--assignee', 'Not A Handle']],
      [['tasks', 'start', 'PM-1', '--bogus']],
      [['tasks', 'start', 'PM-1', '--request-id', 'not-a-uuid']],
      [['messages', 'send', '--project', 'PM', '--file', 'x']],
      [['labels', 'add', 'PM-1']],
      [['labels', 'add', 'PM-1', 'ok', '--note', '']],
      [['inbox', 'list']],
      [['inbox', 'list', '--project', 'PM', '--state', 'weird']],
      [['inbox', 'answer', 'item_1', '--project', 'PM']],
      [['merges', 'list', '--project', 'PM']],
      [['merges', 'prioritize', 'PM-1']],
      [
        [
          'merges',
          'reorder',
          '--project',
          'PM',
          '--repo',
          'web',
          '--reason',
          'r',
          '--expected-revision',
          '1',
        ],
      ],
      [
        [
          'merges',
          'reorder',
          '--project',
          'PM',
          '--repo',
          'web',
          '--reason',
          'r',
          '--expected-revision',
          'x',
          'PM-1',
        ],
      ],
      [['pause']],
      [['pause', '--project', 'PM', '--instance']],
      [['resume', '--instance', '--reason', 'no']],
      [['events', 'follow']],
      [['operations', 'get', 'sop_1']],
      [['operations', 'get', 'bad id', '--project', 'PM']],
    ])('refuses wrong arguments with status 2 and sends nothing: %j', async (args) => {
      const result = await run(args, accepted);
      expect(result.code).toBe(CLIENT_EXIT.usage);
      expect(result.requests).toEqual([]);
      expect(result.stdout).toEqual([]);
      expect(result.output()).not.toContain(CANARY_KEY);
    });

    it('has no token option and no secret environment fallback', async () => {
      for (const command of COMMANDS) expect(Object.keys(command.options)).not.toContain('token');
      const result = await run(['inbox', 'list', '--project', 'PM', '--token', CANARY_KEY], accepted);
      expect(result.code).toBe(CLIENT_EXIT.usage);
      expect(result.requests).toEqual([]);
      // The unknown option is named in the error, so a mistyped secret must not be echoed back.
      expect(result.output()).not.toContain(CANARY_KEY);
    });

    it('answers 3 for a credential file problem before it sends anything', async () => {
      fs.chmodSync(fx.keyFile, 0o644);
      const result = await run(['inbox', 'list', '--project', 'PM'], accepted);
      expect(result.code).toBe(CLIENT_EXIT.auth);
      expect(result.requests).toEqual([]);
      expect(result.stderr.join('')).toContain('credential_mode');
    });

    it('answers 3 for a refused key and 1 for every other refusal, without repeating the call', async () => {
      const refused =
        (status: number, code: string): Handler =>
        () =>
          jsonResponse({ error: { code, message: `refused ${code}` } }, status);
      for (const [status, code, exit] of [
        [401, 'integrator_key_invalid', CLIENT_EXIT.auth],
        [403, 'integrator_read_only', CLIENT_EXIT.failed],
        [403, 'integrator_not_allowed', CLIENT_EXIT.failed],
        [404, 'not_found', CLIENT_EXIT.failed],
        [409, 'conflict', CLIENT_EXIT.failed],
        [500, 'internal_error', CLIENT_EXIT.failed],
      ] as const) {
        const result = await run(['labels', 'add', 'PM-1', 'bug'], refused(status, code));
        expect(result.code, code).toBe(exit);
        expect(result.stderr.join('')).toContain(code);
        expect(result.requests).toHaveLength(1);
      }
    });

    it('treats an unknown server answer as a failure for a read and as accepted for a write', async () => {
      const read = await run(['inbox', 'list', '--project', 'PM'], () => jsonResponse({ nope: true }));
      expect(read.code).toBe(CLIENT_EXIT.failed);
      const write = await run(['tasks', 'start', 'PM-1'], () => jsonResponse({ nope: true }, 200));
      expect(write.code).toBe(CLIENT_EXIT.ok);
      expect(write.stdout.join('')).toContain('"nope":true');
      expect(write.stderr.join('')).toContain('accepted');
    });
  });

  describe('commands', () => {
    it.each([
      {
        args: [
          'tasks',
          'update',
          'PM-1',
          '--title',
          'Changed',
          '--priority',
          'none',
          '--assignee',
          'none',
          '--theme',
          'none',
          '--parent',
          'none',
          '--stage',
          'ready',
          '--add-relation',
          'related:PM-2',
          '--add-relation',
          'prerequisite:PM-3',
          '--remove-relation',
          'has_part:PM-4',
          '--description-file',
          '-',
        ],
        stdin: 'Details',
        taskKey: 'PM-1',
        command: {
          kind: 'task_update',
          taskKey: 'PM-1',
          request: {
            title: 'Changed',
            priority: null,
            assignee: null,
            themeKey: null,
            parentKey: null,
            stageId: 'ready',
            description: 'Details',
            relations: {
              add: [
                { kind: 'related', key: 'PM-2' },
                { kind: 'prerequisite', key: 'PM-3' },
              ],
              remove: [{ kind: 'has_part', key: 'PM-4' }],
            },
          },
        },
      },
      {
        args: ['inbox', 'decide', 'item_1', '--project', 'PM', '--option', 'accept', '--note', 'Agreed'],
        command: { kind: 'inbox_resolve', itemId: 'item_1', request: { optionId: 'accept', note: 'Agreed' } },
      },
      {
        args: ['config', 'set', '--project', 'PM', 'limits.maxConcurrentAi', '2'],
        command: {
          kind: 'operate',
          operation: { op: 'config_patch', patch: { limits: { maxConcurrentAi: 2 } } },
        },
      },
      {
        args: ['config', 'revert', '--project', 'PM', 'abc123'],
        command: { kind: 'operate', operation: { op: 'config_revert', version: 'abc123' } },
      },
      {
        args: ['members', 'hire', '--project', 'PM', '--file', '-'],
        stdin: '{"role":"developer","handle":"new-dev"}',
        command: {
          kind: 'operate',
          operation: { op: 'member_hire', request: { role: 'developer', handle: 'new-dev' } },
        },
      },
      {
        args: ['members', 'update', 'dev', '--project', 'PM', '--file', '-'],
        stdin: '{"displayName":"Developer"}',
        command: { kind: 'member_update', handle: 'dev', request: { displayName: 'Developer' } },
      },
      {
        args: ['members', 'retire', 'dev', '--project', 'PM'],
        command: { kind: 'operate', operation: { op: 'member_retire', handle: 'dev' } },
        waiting: true,
      },
      {
        args: ['keys', 'revoke', 'key_1', '--project', 'PM'],
        command: { kind: 'credential_revoke', keyId: 'key_1' },
        waiting: true,
      },
      {
        args: ['tasks', 'create', '--project', 'PM', '--file', '-'],
        stdin: '{"title":"Card","labels":["refine"]}',
        command: { kind: 'task_create', request: { title: 'Card', labels: ['refine'] } },
      },
      {
        args: ['tasks', 'start', 'PM-1'],
        taskKey: 'PM-1',
        command: { kind: 'task_start', taskKey: 'PM-1', request: {} },
      },
      {
        args: ['labels', 'add', 'PM-1', 'scope-ok'],
        taskKey: 'PM-1',
        command: { kind: 'task_labels', taskKey: 'PM-1', request: { add: ['scope-ok'] } },
      },
      {
        args: ['labels', 'remove', 'PM-1', 'scope-ok'],
        taskKey: 'PM-1',
        command: { kind: 'task_labels', taskKey: 'PM-1', request: { remove: ['scope-ok'] } },
      },
      {
        args: ['pause', '--project', 'PM', '--reason', 'Deploy preview'],
        command: { kind: 'operate', operation: { op: 'project_pause', reason: 'Deploy preview' } },
      },
      {
        args: ['resume', '--project', 'PM'],
        command: { kind: 'operate', operation: { op: 'project_resume' } },
      },
      {
        args: [
          'merges',
          'reorder',
          '--project',
          'PM',
          '--repo',
          'repo',
          '--expected-revision',
          '1',
          '--reason',
          'Order',
          'PM-1',
        ],
        command: {
          kind: 'merge_order',
          repo: 'repo',
          expectedRevision: 1,
          reason: 'Order',
          taskKeys: ['PM-1'],
        },
      },
    ])(
      'sends and repeats the exact super command: $args',
      async ({ args, command, stdin, taskKey, waiting }) => {
        const requestId = '11111111-2222-4333-8444-555555555555';
        const handler: Handler = () => {
          const response = operationBody(command, requestId);
          if (waiting) response.operation.state = 'waiting_owner';
          return jsonResponse(response, 202);
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await run([...args, '--request-id', requestId], handler, { stdin: stdin ?? '' });
          expect(result.code, result.stderr.join('')).toBe(0);
          expect(result.requests).toHaveLength(1);
          expect(result.requests[0]?.url.pathname).toBe('/api/projects/PM/operator-super/operations');
          expect(result.requests[0]?.headers['x-request-id']).toBe(requestId);
          expect(bodyOf(result.requests[0])).toEqual({ requestId, ...(taskKey ? { taskKey } : {}), command });
          expect(result.stdout.join('')).toContain(waiting ? 'waiting_owner' : 'succeeded');
          if (waiting) expect(result.stdout.join('')).toContain('approval');
        }
      },
    );

    it.each([
      ['tasks', 'update', 'PM-1'],
      ['tasks', 'update', 'PM-1', '--priority', 'invalid'],
      ['tasks', 'update', 'PM-1', '--visibility', 'shared'],
      ['tasks', 'update', 'PM-1', '--add-relation', 'invalid:PM-2'],
      ['tasks', 'update', 'PM-1', '--remove-relation', 'related:PM-2:extra'],
      ['config', 'set', '--project', 'PM', 'security', 'true'],
      ['config', 'set', '--project', 'PM', 'limits.__proto__.x', '1'],
      ['config', 'set', '--project', 'PM', 'limits.maxConcurrentAi', 'invalid'],
      ['config', 'set', '--project', 'PM', 'limits.maxConcurrentAi', '"two"'],
      ['queue', '--project', 'PM', '--closed-since', 'yesterday'],
    ])('rejects invalid new arguments: %j', async (...args) => {
      const result = await run(args, accepted);
      expect(result.code).toBe(CLIENT_EXIT.usage);
      expect(result.requests).toEqual([]);
    });

    it('reports an inactive grant as authentication failure with an actionable message', async () => {
      const result = await run(['members', 'retire', 'dev', '--project', 'PM'], () =>
        jsonResponse({ error: { code: 'operator_grant_inactive', message: 'inactive' } }, 403),
      );
      expect(result.code).toBe(CLIENT_EXIT.auth);
      expect(result.stderr.join('')).toContain('Settings › Operator');
    });

    it('prints the created task key in the operation line', async () => {
      const command = { kind: 'task_create', request: { title: 'Card' } };
      const result = await run(
        ['tasks', 'create', '--project', 'PM', '--file', '-'],
        () => {
          const response = operationBody(command);
          return jsonResponse({ operation: { ...response.operation, taskKey: 'PM-12' } });
        },
        { stdin: '{"title":"Card"}' },
      );
      expect(result.stdout.join('')).toContain('<PM-12>');
    });

    it('prints open queue items before closed ones with state, kind, title, card and age', async () => {
      const item = {
        id: 'queue_1',
        projectKey: 'PM',
        member: 'operator',
        kind: 'message',
        source: { type: 'message', messageId: 'msg_1' },
        place: { type: 'general' },
        wake: true,
        state: 'queued',
        title: 'Review work',
        from: 'dev',
        taskKey: 'PM-1',
        queuedAt: new Date(Date.now() - 120000).toISOString(),
        startedAt: null,
        closedAt: null,
        closeReason: null,
        attempts: 0,
        restartedAt: null,
        sessionId: null,
        wait: null,
        outcome: null,
      };
      const result = await run(['queue', '--project', 'PM'], () =>
        jsonResponse({
          member: 'operator',
          items: [item],
          closed: [{ ...item, id: 'queue_2', state: 'done', title: 'Completed work', taskKey: null }],
          everQueued: true,
        }),
      );
      expect(result.code).toBe(0);
      expect(result.stdout.join('')).toBe(
        'queued message Review work PM-1 2m\nclosed:\ndone message Completed work - 2m\n',
      );
    });

    it('reads the Operator queue and forwards closedSince with typed JSON output', async () => {
      const view = { member: 'operator', items: [], closed: [], everQueued: false };
      const result = await run(
        ['queue', '--project', 'PM', '--closed-since', '2026-10-20T00:00:00Z', '--json'],
        () => jsonResponse(view),
      );
      expect(result.code).toBe(0);
      expect(result.requests[0]?.url.pathname).toBe('/api/projects/PM/operator/queue');
      expect(result.requests[0]?.url.searchParams.get('closedSince')).toBe('2026-10-20T00:00:00Z');
      expect(JSON.parse(result.stdout.join(''))).toEqual(view);
    });
    it('every request carries the bearer key, the Access headers and the CLI channel header', async () => {
      const result = await run(['tasks', 'start', 'PM-12'], accepted);
      const [request] = result.requests;
      expect(request?.headers).toMatchObject({
        authorization: `Bearer ${CANARY_KEY}`,
        'cf-access-client-id': CANARY_ACCESS_ID,
        'cf-access-client-secret': CANARY_ACCESS_SECRET,
        [CLIENT_CHANNEL_HEADER.toLowerCase()]: CLIENT_CHANNEL_VALUE,
        'x-request-id': REQUEST_1,
        'content-type': 'application/json',
      });
      expect(request?.redirect).toBe('manual');
      expect(request?.url.origin).toBe('https://pm.example.com');
    });

    it('tasks create: sends the card in the file; "-" reads multiline text from standard input', async () => {
      const card = { title: 'A card', description: 'line one\n\nline two' };
      const fromFile = await run(
        ['tasks', 'create', '--project', 'PM', '--file', fileOf('card.json', JSON.stringify(card))],
        accepted,
      );
      expect(fromFile.code).toBe(0);
      expect(fromFile.requests[0]).toMatchObject({ method: 'POST' });
      expect(fromFile.requests[0]?.url.pathname).toBe('/api/projects/PM/operator-super/operations');
      expect(bodyOf(fromFile.requests[0])).toEqual({
        requestId: REQUEST_1,
        command: { kind: 'task_create', request: card },
      });

      const json = JSON.stringify(card);
      const fromStdin = await run(['tasks', 'create', '--project', 'PM', '--file', '-'], accepted, {
        stdin: [json.slice(0, 10), json.slice(10)],
      });
      expect(fromStdin.code).toBe(0);
      expect(bodyOf(fromStdin.requests[0])).toEqual(bodyOf(fromFile.requests[0]));

      const invalid = await run(['tasks', 'create', '--project', 'PM', '--file', '-'], accepted, {
        stdin: '{"description":"no title"}',
      });
      expect(invalid.code).toBe(CLIENT_EXIT.usage);
      expect(invalid.requests).toEqual([]);
      const notJson = await run(['tasks', 'create', '--project', 'PM', '--file', '-'], accepted, {
        stdin: 'not json',
      });
      expect(notJson.code).toBe(CLIENT_EXIT.usage);
    });

    it('tasks start: starts the card of the project in its key, with an optional assignee', async () => {
      const plain = await run(['tasks', 'start', 'PM-12'], accepted);
      expect(plain.requests[0]?.url.pathname).toBe('/api/projects/PM/operator-super/operations');
      expect(bodyOf(plain.requests[0])).toEqual({
        requestId: REQUEST_1,
        taskKey: 'PM-12',
        command: { kind: 'task_start', taskKey: 'PM-12', request: {} },
      });
      const assigned = await run(
        ['tasks', 'start', 'PM-12', '--project', 'PM', '--assignee', 'dev'],
        accepted,
      );
      expect(bodyOf(assigned.requests[0])).toMatchObject({
        command: { kind: 'task_start', request: { assignee: 'dev' } },
      });
    });

    it('messages send: an operation with the request id; text is trimmed, multiline text stays', async () => {
      const result = await run(
        ['messages', 'send', '--project', 'PM', '--to', 'dev', '--to', 'qa', '--task', 'PM-3', '--file', '-'],
        (request) => jsonResponse(operationBody((bodyOf(request) as { command: unknown }).command), 202),
        { stdin: ['\nfirst line\n\n', '  second line\n'] },
      );
      expect(result.code).toBe(0);
      const [request] = result.requests;
      expect(request?.url.pathname).toBe('/api/projects/PM/operator-super/operations');
      expect(bodyOf(request)).toEqual({
        requestId: REQUEST_1,
        taskKey: 'PM-3',
        command: {
          kind: 'operate',
          operation: {
            op: 'message_send',
            to: ['dev', 'qa'],
            text: 'first line\n\n  second line',
            taskKey: 'PM-3',
          },
        },
      });
      expect(request?.headers['x-request-id']).toBe(REQUEST_1);
      expect(result.stdout.join('')).toContain('operation sop_1 succeeded');
    });

    it('--request-id repeats the same operation request; --json prints the typed answer', async () => {
      const requestId = '11111111-2222-4333-8444-555555555555';
      const command = { kind: 'operate', operation: { op: 'project_pause' } };
      const result = await run(
        [
          'messages',
          'send',
          '--project',
          'PM',
          '--to',
          'dev',
          '--file',
          '-',
          '--request-id',
          requestId,
          '--json',
        ],
        () => jsonResponse(operationBody(command, requestId), 202),
        { stdin: 'hello' },
      );
      expect(bodyOf(result.requests[0])).toMatchObject({ requestId });
      const printed = JSON.parse(result.stdout.join(''));
      expect(printed.operation).toMatchObject({ id: 'sop_1', requestId, state: 'succeeded' });
    });

    it('labels add and remove: one change with the note as the comment', async () => {
      const add = await run(['labels', 'add', 'PM-4', 'code-review-ok', '--note', 'checked'], accepted);
      expect(add.requests[0]?.url.pathname).toBe('/api/projects/PM/operator-super/operations');
      expect(bodyOf(add.requests[0])).toEqual({
        requestId: REQUEST_1,
        taskKey: 'PM-4',
        command: {
          kind: 'task_labels',
          taskKey: 'PM-4',
          request: { add: ['code-review-ok'], comment: 'checked' },
        },
      });
      const remove = await run(['labels', 'remove', 'PM-4', 'waiting-answer'], accepted);
      expect(bodyOf(remove.requests[0])).toMatchObject({
        command: { kind: 'task_labels', request: { remove: ['waiting-answer'] } },
      });
    });

    it('inbox list: a read of the open items, or of a state, with --json', async () => {
      const empty = () => jsonResponse({ items: [] });
      const open = await run(['inbox', 'list', '--project', 'PM'], empty);
      expect(open.code).toBe(0);
      expect(open.requests[0]).toMatchObject({ method: 'GET' });
      expect(`${open.requests[0]?.url.pathname}${open.requests[0]?.url.search}`).toBe(
        '/api/projects/PM/inbox',
      );
      expect(open.requests[0]?.headers['x-request-id']).toBeUndefined();
      expect(open.requests[0]?.body).toBeUndefined();
      const all = await run(['inbox', 'list', '--project', 'PM', '--state', 'all', '--json'], empty);
      expect(all.requests[0]?.url.search).toBe('?state=all');
      expect(JSON.parse(all.stdout.join(''))).toEqual({ items: [] });
    });

    it('inbox list: a fix round limit decision is printed in full, other items as one line', async () => {
      const base = {
        projectKey: 'PM',
        kind: 'decision',
        assignees: ['owner'],
        source: 'system',
        sessionId: null,
        taskKey: 'PM-7',
        body: null,
        options: [],
        state: 'open',
        resolution: null,
        createdAt: '2026-10-18T10:00:00.000Z',
      };
      const fixLimit = {
        taskKey: 'PM-7',
        rounds: 3,
        limit: 3,
        changeRequests: 3,
        designChangeRequests: 0,
        sendBacks: 0,
        reason: 'passed_on',
        decider: 'claude',
        note: null,
      };
      const items = [
        {
          ...base,
          id: 'item_1',
          title: 'Fix limit PM-7',
          body: 'Ismétlődés: ugyanaz a teszt.\nAjánlás: another_round',
          payload: { fixLimit },
        },
        { ...base, id: 'item_2', title: 'Plain decision', body: 'Not printed.', payload: {} },
      ];
      const result = await run(['inbox', 'list', '--project', 'PM'], () => jsonResponse({ items }));
      expect(result.stdout.join('')).toBe(
        'item_1 decision open Fix limit PM-7\nIsmétlődés: ugyanaz a teszt.\nAjánlás: another_round\n\nitem_2 decision open Plain decision\n',
      );
      const asJson = await run(['inbox', 'list', '--project', 'PM', '--json'], () => jsonResponse({ items }));
      expect(JSON.parse(asJson.stdout.join('')).items[0].body).toContain('Ismétlődés');
    });

    it('inbox fix-limit: only the dedicated endpoint, with the option and the note', async () => {
      const item = {
        id: 'item_3',
        projectKey: 'PM',
        kind: 'decision',
        assignees: ['owner'],
        source: 'system',
        sessionId: null,
        taskKey: 'PM-7',
        title: 'Fix limit',
        body: null,
        payload: {},
        options: [],
        state: 'resolved',
        resolution: null,
        createdAt: '2026-10-18T10:00:00.000Z',
      };
      const result = await run(
        ['inbox', 'fix-limit', 'item_3', '--project', 'PM', '--option', 'to_owner', '--note', 'Your call.'],
        () => jsonResponse({ item }),
      );
      expect(result.code).toBe(0);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({ method: 'POST' });
      expect(result.requests[0]?.url.pathname).toBe(
        '/api/projects/PM/inbox/item_3/resolve-integrator-fix-limit',
      );
      expect(bodyOf(result.requests[0])).toEqual({ optionId: 'to_owner', note: 'Your call.' });
      expect(result.requests[0]?.headers['x-request-id']).toBe(REQUEST_1);
      const without = await run(
        ['inbox', 'fix-limit', 'item_3', '--project', 'PM', '--option', 'another_round'],
        () => jsonResponse({ item }),
      );
      expect(bodyOf(without.requests[0])).toEqual({ optionId: 'another_round' });
    });

    it('inbox fix-limit: refuses a wrong option, a missing note for to_owner and a bad item id before any request', async () => {
      for (const args of [
        ['inbox', 'fix-limit', 'item_3', '--project', 'PM'],
        ['inbox', 'fix-limit', 'item_3', '--project', 'PM', '--option', 'approve'],
        ['inbox', 'fix-limit', 'item_3', '--project', 'PM', '--option', 'to_owner'],
        ['inbox', 'fix-limit', 'item/3', '--project', 'PM', '--option', 'replan'],
        ['inbox', 'fix-limit', '--project', 'PM', '--option', 'replan'],
      ]) {
        const result = await run(args, accepted);
        expect(result.code, args.join(' ')).toBe(CLIENT_EXIT.usage);
        expect(result.requests, args.join(' ')).toHaveLength(0);
      }
    });

    it('inbox answer: only the relay endpoint, with the answer text as it is', async () => {
      const result = await run(['inbox', 'answer', 'item_9', '--project', 'PM', '--file', '-'], accepted, {
        stdin: 'Yes.\nGo on.\n',
      });
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]?.url.pathname).toBe('/api/projects/PM/inbox/item_9/relay-answer');
      expect(bodyOf(result.requests[0])).toEqual({ answer: 'Yes.\nGo on.' });
    });

    it('merges: list, enqueue, prioritize and reorder', async () => {
      const list = await run(['merges', 'list', '--project', 'PM', '--repo', 'web'], () =>
        jsonResponse({ revision: 3, taskKeys: ['PM-1', 'PM-2'] }),
      );
      expect(`${list.requests[0]?.url.pathname}${list.requests[0]?.url.search}`).toBe(
        '/api/projects/PM/merge-queue/order?repo=web',
      );
      expect(list.stdout.join('')).toBe('revision 3: PM-1 PM-2\n');
      const asJson = await run(['merges', 'list', '--project', 'PM', '--repo', 'web', '--json'], () =>
        jsonResponse({ revision: 3, taskKeys: ['PM-1', 'PM-2'] }),
      );
      expect(JSON.parse(asJson.stdout.join(''))).toEqual({ revision: 3, taskKeys: ['PM-1', 'PM-2'] });

      const enqueue = await run(['merges', 'enqueue', 'PM-7'], accepted);
      expect(enqueue.requests[0]?.url.pathname).toBe('/api/projects/PM/operator-super/operations');
      expect(bodyOf(enqueue.requests[0])).toEqual({
        requestId: REQUEST_1,
        taskKey: 'PM-7',
        command: { kind: 'merge', taskKey: 'PM-7', request: {} },
      });

      const prioritize = await run(['merges', 'prioritize', 'PM-7', '--reason', 'urgent fix'], accepted);
      expect(prioritize.requests[0]?.url.pathname).toBe('/api/projects/PM/tasks/PM-7/merge/prioritize');
      expect(bodyOf(prioritize.requests[0])).toEqual({ reason: 'urgent fix' });

      const reorder = await run(
        [
          'merges',
          'reorder',
          '--project',
          'PM',
          '--repo',
          'web',
          '--expected-revision',
          '3',
          '--reason',
          'order',
          'PM-2',
          'PM-1',
        ],
        accepted,
      );
      expect(bodyOf(reorder.requests[0])).toEqual({
        requestId: REQUEST_1,
        command: {
          kind: 'merge_order',
          repo: 'web',
          expectedRevision: 3,
          taskKeys: ['PM-2', 'PM-1'],
          reason: 'order',
        },
      });
    });

    it('pause and resume: a project or the instance, with an optional reason', async () => {
      const pause = await run(['pause', '--project', 'PM', '--reason', 'deploy'], accepted);
      expect(pause.requests[0]?.url.pathname).toBe('/api/projects/PM/operator-super/operations');
      expect(bodyOf(pause.requests[0])).toMatchObject({
        command: { kind: 'operate', operation: { op: 'project_pause' } },
      });
      const resume = await run(['resume', '--project', 'PM'], accepted);
      expect(resume.requests[0]?.url.pathname).toBe('/api/projects/PM/operator-super/operations');
      expect(bodyOf(resume.requests[0])).toEqual({
        requestId: REQUEST_1,
        command: { kind: 'operate', operation: { op: 'project_resume' } },
      });
      const instance = await run(['pause', '--instance'], accepted);
      expect(instance.requests[0]?.url.pathname).toBe('/api/pause');
      const instanceResume = await run(['resume', '--instance'], accepted);
      expect(instanceResume.requests[0]?.url.pathname).toBe('/api/pause/resume');
    });

    it('operations get: reads one operation and its result', async () => {
      const command = { kind: 'operate', operation: { op: 'project_pause' } };
      const result = await run(['operations', 'get', 'sop_1', '--project', 'PM'], () =>
        jsonResponse({ ...operationBody(command), result: null }),
      );
      expect(result.code).toBe(0);
      expect(result.requests[0]).toMatchObject({ method: 'GET' });
      expect(result.requests[0]?.url.pathname).toBe('/api/projects/PM/operator-super/operations/sop_1');
      expect(result.stdout.join('')).toBe('operation sop_1 succeeded\n');
      const missing = await run(['operations', 'get', 'sop_9', '--project', 'PM'], () =>
        jsonResponse({ error: { code: 'not_found', message: 'no such operation' } }, 404),
      );
      expect(missing.code).toBe(CLIENT_EXIT.failed);
    });
  });

  describe('unknown outcomes and safe retries', () => {
    const broken: Handler = () => {
      throw new TypeError(`fetch failed ${CANARY_KEY}`, { cause: { code: 'ECONNRESET' } });
    };

    it('does not repeat a write whose outcome is unknown: it says so, with the request id', async () => {
      const result = await run(['tasks', 'start', 'PM-1'], broken);
      expect(result.code).toBe(CLIENT_EXIT.failed);
      expect(result.requests).toHaveLength(1);
      const text = result.stderr.join('');
      expect(text).toContain('ECONNRESET');
      expect(text).toContain('unknown');
      expect(text).toContain(REQUEST_1);
    });

    it.each([502, 504])(
      'a gateway %i on a write is an unknown outcome, with the request id; the server is not asked again',
      async (status) => {
        const result = await run(
          ['tasks', 'start', 'PM-1'],
          () => new Response('<html>gateway</html>', { status, headers: { 'content-type': 'text/html' } }),
        );
        expect(result.code).toBe(CLIENT_EXIT.failed);
        expect(result.requests).toHaveLength(1);
        expect(result.stderr.join('')).toContain('gateway_error');
        expect(result.stderr.join('')).toContain('unknown');
        expect(result.stderr.join('')).toContain(REQUEST_1);
      },
    );

    it('a 503 on a write was not served, and the server own error code wins over the gateway reading', async () => {
      const unserved = await run(
        ['tasks', 'start', 'PM-1'],
        () => new Response('unavailable', { status: 503 }),
      );
      expect(unserved.code).toBe(CLIENT_EXIT.failed);
      expect(unserved.stderr.join('')).not.toContain('unknown');
      const own = await run(['tasks', 'start', 'PM-1'], () =>
        jsonResponse({ error: { code: 'busy', message: 'try later' } }, 503),
      );
      expect(own.stderr.join('')).toContain('busy');
      expect(own.stderr.join('')).not.toContain('gateway_error');
    });

    it('does not claim an unknown outcome for a read', async () => {
      const result = await run(['inbox', 'list', '--project', 'PM'], broken);
      expect(result.code).toBe(CLIENT_EXIT.failed);
      expect(result.requests).toHaveLength(1);
      expect(result.stderr.join('')).not.toContain('unknown');
    });

    it('does not follow a redirect, even to another origin, and takes the credentials nowhere', async () => {
      const result = await run(
        ['tasks', 'start', 'PM-1'],
        () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
      );
      expect(result.code).toBe(CLIENT_EXIT.failed);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]?.url.host).toBe('pm.example.com');
      expect(result.stderr.join('')).toContain('redirect');
      expect(result.output()).not.toContain('evil.example');
    });

    it('refuses to build a request for another origin', async () => {
      const credentials = loadCredentials({ home: fx.home });
      const t = createTestIo(fx.home, accepted);
      const api = createApiClient({ credentials, fetch: t.io.fetch });
      await expect(
        api.send({ method: 'GET', path: '//evil.example/x', write: false }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(t.requests).toEqual([]);
    });
  });

  describe('secrets', () => {
    const everyCanary = (text: string) => {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    };

    it('keeps the key and the Access values out of stdout, stderr and --verbose lines on every path', async () => {
      const echo =
        (status: number): Handler =>
        () =>
          jsonResponse(
            {
              error: {
                code: 'echo',
                message: `Authorization: Bearer ${CANARY_KEY} ${CANARY_ACCESS_SECRET} CF-Access-Client-Id: ${CANARY_ACCESS_ID}`,
              },
            },
            status,
          );
      const cases: Array<[string[], Handler]> = [
        [['tasks', 'start', 'PM-1', '--verbose'], echo(401)],
        [['tasks', 'start', 'PM-1', '--verbose'], echo(403)],
        [['inbox', 'list', '--project', 'PM', '--verbose', '--json'], echo(500)],
        [
          ['tasks', 'start', 'PM-1', '--verbose'],
          () => {
            throw new TypeError(`${CANARY_KEY}`, { cause: { code: `E${CANARY_ACCESS_SECRET}` } });
          },
        ],
        [
          ['tasks', 'start', 'PM-1', '--verbose'],
          () => new Response('not json ' + CANARY_KEY, { status: 200 }),
        ],
        [
          ['tasks', 'start', 'PM-1', '--verbose'],
          () =>
            new Response(null, { status: 307, headers: { location: `https://x.example/?k=${CANARY_KEY}` } }),
        ],
        [
          ['inbox', 'list', '--project', 'PM', '--verbose'],
          () => jsonResponse({ items: [], leaked: CANARY_KEY }),
        ],
      ];
      for (const [args, handler] of cases) {
        const result = await run(args, handler);
        everyCanary(result.output());
        // Only the request itself carries the key, in the one header that exists for it.
        for (const request of result.requests) {
          expect(request.url.href).not.toContain('pmi_');
          expect(request.body ?? '').not.toContain('pmi_');
        }
      }
    });

    it('--verbose shows the method, path and status only', async () => {
      const result = await run(['inbox', 'list', '--project', 'PM', '--verbose'], () =>
        jsonResponse({ items: [] }),
      );
      const text = result.stderr.join('');
      expect(text).toContain('GET /api/projects/PM/inbox');
      expect(text).toContain('-> 200');
      expect(text.toLowerCase()).not.toContain('authorization');
      everyCanary(text);
    });

    it('the client sources never read the environment or start a child process', () => {
      const dir = path.resolve(import.meta.dirname, '../../../scripts/projectman');
      for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.ts'))) {
        const source = fs.readFileSync(path.join(dir, name), 'utf8');
        expect(source, name).not.toMatch(/process\.env|child_process|execa|spawn\(/);
        expect(source, name).not.toMatch(/console\.(log|error|warn|debug)/);
      }
    });
  });
});
