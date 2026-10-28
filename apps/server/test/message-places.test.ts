import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiMemberConfig, UiPlace } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { MessagePlaceArg, ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush } from './helpers/fakes';

/** The places the project manager offers under a message, and the place a person writes from (PM-1071). */
describe('message places and location (PM-1071)', () => {
  let h: DomainHarness;
  let pm: ToolContext;

  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        (config.team.members.find((m) => m.handle === 'pm') as AiMemberConfig).onLeave = false;
        config.team.members.push({
          kind: 'human',
          handle: 'guest',
          displayName: 'Guest',
          access: 'developer',
          roles: [],
        });
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const context = async (member: string): Promise<ToolContext> => {
      const { session } = await h.domain.sessions.ensureSession('AR', member, { type: 'general' });
      await flush();
      return { projectKey: 'AR', member, sessionId: session.id, taskKey: null };
    };
    pm = await context('pm');
  });
  afterEach(() => h.cleanup());

  const send = (ctx: ToolContext, to: string[], places?: MessagePlaceArg[]) =>
    h.domain.teamTools.sendMessage(ctx, {
      to,
      text: 'Look here',
      kind: 'info',
      ...(places ? { places } : {}),
    });

  it('stores the places with the message the person reads, and maps the card key', async () => {
    const result = await send(
      pm,
      ['owner'],
      [
        { page: 'card', task_key: 'AR-1', view: 'thread' },
        { page: 'settings', section: 'labels' },
      ],
    );
    expect(h.repos.messages.get(result.messageId)!.places).toEqual([
      { page: 'card', taskKey: 'AR-1', view: 'thread' },
      { page: 'settings', section: 'labels' },
    ]);
  });

  it('stores no places for a message without them', async () => {
    const result = await send(pm, ['owner']);
    expect(h.repos.messages.get(result.messageId)!.places).toBeUndefined();
  });

  it('refuses a card with no key before anything is sent', async () => {
    const err = await rejection(send(pm, ['owner'], [{ page: 'card' }]), TeamToolError);
    expect(err.message).toContain('places[0]');
  });

  /** What the messaging service refuses, by the error code the web and the tool report. */
  const refusedCode = async (from: string, to: string[], places: UiPlace[]) =>
    (
      await rejection(
        h.domain.messaging.send(
          'AR',
          from,
          { to, text: 'Look' },
          { actor: { kind: 'ai', handle: from }, places },
        ),
      )
    ).code;

  it.each([
    [
      'another member than the project manager',
      'dev-1',
      ['owner'],
      [{ page: 'board' }],
      'project_manager_only',
    ],
    ['an AI recipient', 'pm', ['dev-1'], [{ page: 'board' }], 'invalid_request'],
    ['the same place twice', 'pm', ['owner'], [{ page: 'board' }, { page: 'board' }], 'invalid_request'],
    [
      'a part of the settings the person does not see',
      'pm',
      ['guest'],
      [{ page: 'settings', section: 'email' }],
      'place_not_visible',
    ],
    [
      'a machine-level part for anyone',
      'pm',
      ['owner'],
      [{ page: 'settings', section: 'engines' }],
      'place_not_target',
    ],
    ['a card the project does not have', 'pm', ['owner'], [{ page: 'card', taskKey: 'AR-99' }], 'not_found'],
    [
      'a member the project does not have',
      'pm',
      ['owner'],
      [{ page: 'member', handle: 'nobody' }],
      'not_found',
    ],
  ] as [string, string, string[], UiPlace[], string][])(
    'refuses %s',
    async (_name, from, to, places, code) => {
      expect(await refusedCode(from, to, places)).toBe(code);
    },
  );

  it('keeps the place a person writes from, and delivers it to the project manager last', async () => {
    h.runner.setState(pm.sessionId, 'idle');
    const message = await h.domain.messaging.send(
      'AR',
      'owner',
      { to: ['pm'], text: 'What is this?', location: { page: 'board', taskKey: 'AR-1', view: 'thread' } },
      { actor: OWNER_ACTOR },
    );
    expect(h.repos.messages.get(message.id)!.location).toEqual({
      page: 'board',
      taskKey: 'AR-1',
      view: 'thread',
    });
    await flush();
    const typed = h.runner.messages.map((m) => m.text).find((text) => text.includes('What is this?'));
    expect(typed).toMatch(/What is this\?\n\n\[app location of owner: page=board card=AR-1 view=thread\./);
  });
});
