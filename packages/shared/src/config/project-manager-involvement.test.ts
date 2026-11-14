import { describe, expect, it } from 'vitest';
import { NewSuperCommand } from '../api/super-handoff';
import { involvementAsksOwner } from './project-manager-involvement';

const commands = [
  [{ kind: 'operate', operation: { op: 'config_patch', patch: { project: { name: 'Example' } } } }, true],
  [{ kind: 'operate', operation: { op: 'config_revert', version: 'v1' } }, true],
  [
    { kind: 'operate', operation: { op: 'member_update', handle: 'dev', changes: { model: 'sonnet' } } },
    true,
  ],
  [
    {
      kind: 'operate',
      operation: {
        op: 'member_hire',
        request: {
          handle: 'dev',
          displayName: 'Dev',
          role: 'developer',
          provider: 'claude',
          model: 'sonnet',
        },
      },
    },
    true,
  ],
  [{ kind: 'operate', operation: { op: 'member_retire', handle: 'dev' } }, true],
  [{ kind: 'operate', operation: { op: 'member_rename', handle: 'dev', to: 'developer' } }, false],
  [{ kind: 'operate', operation: { op: 'message_send', to: ['dev'], text: 'Continue' } }, false],
  [{ kind: 'operate', operation: { op: 'session_stop', sessionId: 'ses_1' } }, false],
  [{ kind: 'operate', operation: { op: 'project_pause' } }, false],
  [{ kind: 'operate', operation: { op: 'project_resume' } }, false],
  [{ kind: 'member_update', handle: 'dev', request: { model: 'sonnet' } }, false],
  [{ kind: 'task_create', request: { title: 'Example' } }, false],
] as const;

describe.each(['every_step', 'important', 'minimal'] as const)('%s involvement', (involvement) => {
  it.each(commands)('adds a question only for settings operations: %j', (input, settings) => {
    const command = NewSuperCommand.parse(input);
    expect(involvementAsksOwner(involvement, command)).toBe(involvement === 'every_step' && settings);
  });
});
