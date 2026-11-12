import { describe, expect, it } from 'vitest';
import type { ResolveInboxRequest } from '../api/dto';
import { RETIRED_OPERATOR_HANDLE } from '../config/operator-member';
import { ProjectConfig } from '../config/schema';
import { connectedActorOf } from './actor-origin';
import { TODO_CANNOT_OPTION, TODO_DONE_OPTION } from './inbox';
import type { InboxItem } from './inbox';
import { inboxResolveRefusal } from './inbox-resolve';
import type { InboxResolveFacts, InboxResolver } from './inbox-resolve';

const config = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'AR', name: 'Acme', workspacePath: '/work/acme', repos: [] },
  team: {
    members: [
      { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: [] },
      { kind: 'human', handle: 'admin', displayName: 'Admin', access: 'admin', roles: [] },
      { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
    ],
    limits: {},
  },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'dev', name: 'Development', kind: 'work', columnId: 'all' },
      {
        id: 'done',
        name: 'Done',
        kind: 'done',
        columnId: 'all',
        gate: { conditions: [{ type: 'has_label', label: 'merge-ok' }] },
      },
    ],
    labels: [{ id: 'merge-ok', name: 'Merge', setBy: { members: ['admin'], humansOnly: true } }],
  },
});

const question = { question: 'Which port?' };
const options = ['answer', 'approve', 'allow', 'dismiss', TODO_CANNOT_OPTION.id].map((id) => ({
  id,
  label: id,
  style: 'primary' as const,
}));
const item: InboxItem = {
  id: 'inb_1',
  projectKey: 'AR',
  kind: 'question',
  assignees: ['owner'],
  source: 'dev-1',
  sessionId: null,
  taskKey: null,
  title: 'Asked',
  body: null,
  payload: question,
  options,
  state: 'open',
  resolution: null,
  createdAt: '2026-11-12T10:00:00.000Z',
};
const integratorTodo: InboxItem = {
  ...item,
  payload: {
    ...question,
    recipient: 'integrator',
    integratorOpenedAt: '2026-11-12T10:05:00.000Z',
    screening: {
      until: '2026-11-12T10:10:00.000Z',
      outcome: 'todo',
      todo: { what: 'Check the port', where: 'AR', expected: 'A port', recipient: 'integrator' },
    },
  },
  options: [TODO_DONE_OPTION, TODO_CANNOT_OPTION],
};
const decision: InboxItem = { ...item, kind: 'decision' };
const credential = { id: 'key_1', prefix: 'pm_' };
const superActor = connectedActorOf('owner', credential);

const own: InboxResolver = { handle: 'owner', access: 'owner' };
const relayed: InboxResolver = { ...own, via: 'integrator' };
const superResolver: InboxResolver = { ...own, via: 'integrator', superActor };
const facts: InboxResolveFacts = {
  config,
  credential: null,
  groupMembers: [],
  sessionMemberOf: () => null,
  task: null,
};
const superFacts: InboxResolveFacts = { ...facts, credential: { mode: 'super', boundOrigin: true } };
const answer: ResolveInboxRequest = { optionId: 'answer', note: '4700' };

describe('inboxResolveRefusal (S-03)', () => {
  it.each<[string, InboxItem, ResolveInboxRequest, InboxResolver, InboxResolveFacts, string | null]>([
    ['lets the owner answer', item, answer, own, facts, null],
    [
      'lets a super step decide on the owner’s authority',
      decision,
      { optionId: 'approve' },
      superResolver,
      superFacts,
      null,
    ],
    [
      'lets a super step close an integrator todo',
      integratorTodo,
      { optionId: TODO_DONE_OPTION.id },
      superResolver,
      { ...superFacts, integratorTodo: true },
      null,
    ],
    [
      'refuses a read credential',
      item,
      answer,
      superResolver,
      { ...facts, credential: { mode: 'read', boundOrigin: true } },
      'integrator_read_only',
    ],
    [
      'refuses a super credential without a bound origin',
      decision,
      { optionId: 'approve' },
      superResolver,
      { ...superFacts, credential: { mode: 'super', boundOrigin: false } },
      'owner_approval_required',
    ],
    [
      'refuses a todo close outside super scope',
      integratorTodo,
      { optionId: TODO_DONE_OPTION.id },
      own,
      { ...facts, integratorTodo: true },
      'integrator_not_allowed',
    ],
    [
      'refuses a todo close by a non-owner',
      integratorTodo,
      { optionId: TODO_DONE_OPTION.id },
      { ...superResolver, access: 'admin' },
      { ...superFacts, integratorTodo: true },
      'insufficient_access',
    ],
    [
      'refuses a todo close of a closed item',
      { ...integratorTodo, state: 'resolved' },
      { optionId: TODO_DONE_OPTION.id },
      superResolver,
      { ...superFacts, integratorTodo: true },
      'inbox_item_closed',
    ],
    [
      'refuses a todo close of a protected item',
      decision,
      { optionId: TODO_DONE_OPTION.id },
      superResolver,
      { ...superFacts, integratorTodo: true },
      'owner_approval_required',
    ],
    [
      'refuses a todo close of a plain question',
      item,
      { optionId: TODO_DONE_OPTION.id },
      superResolver,
      { ...superFacts, integratorTodo: true },
      'super_relay_refused',
    ],
    [
      'refuses a todo close with another option',
      integratorTodo,
      answer,
      superResolver,
      { ...superFacts, integratorTodo: true },
      'invalid_request',
    ],
    [
      'refuses a relayed answer to an integrator todo',
      integratorTodo,
      { optionId: TODO_DONE_OPTION.id },
      relayed,
      facts,
      'super_relay_refused',
    ],
    [
      'refuses a permission outside the own login',
      { ...item, kind: 'permission' },
      { optionId: 'allow' },
      superResolver,
      superFacts,
      'owner_approval_required',
    ],
    [
      'refuses a relayed decision',
      decision,
      { optionId: 'approve' },
      relayed,
      facts,
      'owner_approval_required',
    ],
    [
      'refuses attachments on a decision',
      decision,
      { optionId: 'approve', attachmentIds: ['att_1'] },
      own,
      facts,
      'invalid_request',
    ],
    ['refuses a closed item', { ...item, state: 'resolved' }, answer, own, facts, 'inbox_item_closed'],
    [
      'refuses a non-owner on a super operation question',
      {
        ...item,
        payload: {
          ...question,
          superOperation: {
            operationId: 'sop_1',
            commandHash: 'hash',
            expectedConfigVersion: null,
            expiresAt: '2026-11-13T10:00:00.000Z',
          },
        },
      },
      answer,
      { handle: 'admin', access: 'admin' },
      facts,
      'owner_approval_required',
    ],
    [
      'refuses a relayed answer to the integrator’s own question',
      {
        ...item,
        payload: {
          ...question,
          responsePurpose: 'information',
          externalQuestion: { ownerUserId: 'usr_1', actor: superActor, requestId: 'req_1' },
        },
      },
      answer,
      relayed,
      facts,
      'super_relay_refused',
    ],
    [
      'refuses a super step of a connected AI member',
      decision,
      { optionId: 'approve' },
      { ...superResolver, superActor: connectedActorOf('owner', credential, { issuer: 'dev-1' }) },
      superFacts,
      'owner_approval_required',
    ],
    [
      'refuses a super step when a group member is reserved',
      decision,
      { optionId: 'approve' },
      superResolver,
      { ...superFacts, groupMembers: [{ ...decision, id: 'inb_2', source: RETIRED_OPERATOR_HANDLE }] },
      'owner_approval_required',
    ],
    [
      'refuses a retired Operator approval',
      {
        ...item,
        kind: 'approval',
        payload: {
          operator: {
            requestId: 'opr_1',
            stepId: 'ops_1',
            quote: 'Pause the team',
            action: 'project_pause',
            operation: { op: 'project_pause' },
            changes: [],
            consequence: 'project_pause',
            baseVersion: null,
            session: null,
            stale: null,
          },
        },
      },
      { optionId: 'approve' },
      own,
      facts,
      'inbox_item_closed',
    ],
    [
      'refuses a stale knowledge proposal except its dismissal',
      {
        ...item,
        kind: 'approval',
        payload: {
          operatorKnowledge: {
            id: 'okp_1',
            requestId: 'opr_1',
            stepId: 'ops_1',
            baseRevision: 0,
            change: {
              kind: 'agreement_replace',
              agreement: { summary: 'Agreed', involvement: 'important', extraCritical: [] },
            },
            operations: [],
            changes: [],
            baseConfigVersion: null,
            proposedBy: 'owner',
            stale: { reason: 'config_changed', at: '2026-11-12T10:01:00.000Z' },
            applying: null,
          },
        },
      },
      { optionId: 'approve' },
      own,
      facts,
      'operator_knowledge_stale',
    ],
    ['refuses an unknown option', item, { optionId: 'nope' }, own, facts, 'unknown_option'],
    [
      'refuses an AI resolver',
      item,
      answer,
      { handle: 'dev-1', access: 'developer' },
      facts,
      'ai_approval_forbidden',
    ],
    [
      'refuses a gate approval the label rules forbid',
      {
        ...decision,
        payload: {
          gate: {
            requestId: 'gat_1',
            taskKey: 'AR-1',
            fromStageId: 'dev',
            toStageId: 'done',
            stageId: 'done',
            label: 'merge-ok',
            requestedBy: { kind: 'ai', handle: 'dev-1' },
          },
        },
      },
      { optionId: 'approve' },
      own,
      facts,
      'not_an_assignee',
    ],
    [
      'refuses a decision of another assignee',
      { ...decision, assignees: ['admin'] },
      { optionId: 'approve' },
      own,
      facts,
      'not_an_assignee',
    ],
    [
      'refuses a free-text answer without a note',
      item,
      { optionId: 'answer' },
      own,
      facts,
      'answer_required',
    ],
    [
      'refuses a todo refusal without a reason',
      item,
      { optionId: TODO_CANNOT_OPTION.id },
      own,
      facts,
      'todo_reason_required',
    ],
    [
      'refuses a retired release approval',
      { ...item, kind: 'release' },
      { optionId: 'approve' },
      own,
      facts,
      'inbox_item_closed',
    ],
    [
      'refuses attachments on a person’s question',
      { ...item, source: 'admin' },
      { ...answer, attachmentIds: ['att_1'] },
      own,
      facts,
      'invalid_request',
    ],
  ])('%s', (_name, target, request, resolver, given, code) => {
    expect(inboxResolveRefusal(target, request, resolver, given)?.code ?? null).toBe(code);
  });
});
