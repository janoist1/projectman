import { describe, expect, it } from 'vitest';
import type { HumanAccess, UiLocation, UiPlace } from '@projectman/shared';
import { placePath, placeState, uiLocationOf } from './places';

const known = {
  titles: new Map([['AC-20', 'Login page']]),
  names: new Map([['kata', 'Kata']]),
};

describe('where the writer is (PM-1071)', () => {
  it.each([
    ['/p/AC', { page: 'board' }],
    ['/p/AC/tasks/AC-20', { page: 'board', taskKey: 'AC-20', view: 'card' }],
    ['/p/AC/tasks/AC-20/thread', { page: 'board', taskKey: 'AC-20', view: 'thread' }],
    ['/p/AC/inbox/tasks/AC-20/timeline', { page: 'inbox', taskKey: 'AC-20', view: 'timeline' }],
    ['/p/AC/map/tasks/AC-20', { page: 'map', taskKey: 'AC-20', view: 'card' }],
    ['/p/AC/team/kata', { page: 'member', handle: 'kata' }],
    ['/p/AC/messages/with/kata', { page: 'messages', handle: 'kata' }],
    ['/p/AC/settings/email', { page: 'settings', section: 'email' }],
    ['/p/AC/sessions/ses_abcdefghij12', { page: 'session', sessionId: 'ses_abcdefghij12' }],
    ['/p/AC/how-we-work', { page: 'how_we_work' }],
  ] as [string, UiLocation][])('reads %s', (path, expected) => {
    expect(uiLocationOf(path)).toEqual(expected);
  });

  it('keeps the page when a part of the address is not a known value, and is "other" for an unknown page', () => {
    expect(uiLocationOf('/p/AC/settings/nonsense')).toEqual({ page: 'settings' });
    expect(uiLocationOf('/p/AC/tasks/AC-20/nonsense')).toEqual({
      page: 'board',
      taskKey: 'AC-20',
    });
    expect(uiLocationOf('/p/AC/no-such-page')).toEqual({ page: 'other' });
  });

  it('leaves out a card the writer took off the message', () => {
    expect(uiLocationOf('/p/AC/inbox/tasks/AC-20', 'AC-20')).toEqual({ page: 'inbox' });
  });
});

describe('the address of an offered place', () => {
  const from: UiLocation = { page: 'board' };
  it.each([
    [{ page: 'board' }, '/p/AC'],
    [{ page: 'card', taskKey: 'AC-20', view: 'thread' }, '/p/AC/tasks/AC-20/thread'],
    [{ page: 'card', taskKey: 'AC-20', view: 'card' }, '/p/AC/tasks/AC-20'],
    [{ page: 'member', handle: 'kata' }, '/p/AC/team/kata'],
    [{ page: 'settings', section: 'labels' }, '/p/AC/settings/labels'],
    [{ page: 'how_we_work' }, '/p/AC/how-we-work'],
    [{ page: 'sessions' }, '/p/AC/sessions'],
  ] as [UiPlace, string][])('goes from %j to %s', (place, path) => {
    expect(placePath('AC', place, from)).toBe(path);
  });

  it('opens a card over the inbox or the map when the reader is on one', () => {
    const card: UiPlace = { page: 'card', taskKey: 'AC-20' };
    expect(placePath('AC', card, { page: 'inbox' })).toBe('/p/AC/inbox/tasks/AC-20');
    expect(placePath('AC', card, { page: 'map', taskKey: 'AC-1', view: 'card' })).toBe(
      '/p/AC/map/tasks/AC-20',
    );
  });
});

describe('what a place button does for the reader', () => {
  const state = (place: UiPlace, from: UiLocation, access: HumanAccess = 'developer') =>
    placeState(place, from, access, known);

  it('is "here" on the same page, the same card (a given view must match), the same settings part', () => {
    expect(state({ page: 'team' }, { page: 'team' })).toBe('here');
    expect(
      state({ page: 'card', taskKey: 'AC-20' }, { page: 'inbox', taskKey: 'AC-20', view: 'thread' }),
    ).toBe('here');
    expect(
      state(
        { page: 'card', taskKey: 'AC-20', view: 'thread' },
        { page: 'board', taskKey: 'AC-20', view: 'card' },
      ),
    ).toBe('go');
    expect(state({ page: 'settings', section: 'labels' }, { page: 'settings', section: 'labels' })).toBe(
      'here',
    );
    expect(state({ page: 'settings', section: 'labels' }, { page: 'settings', section: 'duties' })).toBe(
      'go',
    );
  });

  it('is a way there from a page with a card open over it', () => {
    expect(state({ page: 'board' }, { page: 'board', taskKey: 'AC-20', view: 'card' })).toBe('go');
  });

  it('is not available for a part the reader does not see, a card or a member that is gone', () => {
    expect(state({ page: 'settings', section: 'email' }, { page: 'board' })).toBe('unavailable');
    expect(state({ page: 'settings', section: 'email' }, { page: 'board' }, 'owner')).toBe('go');
    expect(state({ page: 'card', taskKey: 'AC-99' }, { page: 'board' })).toBe('unavailable');
    expect(state({ page: 'member', handle: 'nobody' }, { page: 'board' })).toBe('unavailable');
    expect(placeState({ page: 'board' }, { page: 'inbox' }, undefined, known)).toBe('unavailable');
  });
});
