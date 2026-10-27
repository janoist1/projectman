import { describe, expect, it } from 'vitest';
import { UiLocation, UiPlace, settingsSectionVisible, uiPlaceRefusal } from './ui-place';

describe('the place a message offers', () => {
  it.each([
    { page: 'card' },
    { page: 'member' },
    { page: 'board', taskKey: 'AR-1' },
    { page: 'board', view: 'thread' },
    { page: 'settings', handle: 'dev' },
    { page: 'team', section: 'email' },
    { page: 'unknown' },
    { page: 'board', note: 'free text' },
  ])('refuses %j', (place) => {
    expect(UiPlace.safeParse(place).success).toBe(false);
  });

  it('accepts a card with a view and a settings section', () => {
    expect(UiPlace.safeParse({ page: 'card', taskKey: 'AR-1', view: 'thread' }).success).toBe(true);
    expect(UiPlace.safeParse({ page: 'settings', section: 'labels' }).success).toBe(true);
  });
});

describe('the place a person writes from', () => {
  it.each([
    { page: 'inbox', taskKey: 'AR-1', view: 'timeline' },
    { page: 'member', handle: 'dev' },
    { page: 'session', sessionId: 'ses_abcdefghij12' },
    { page: 'settings', section: 'email' },
    { page: 'other' },
  ])('accepts %j', (location) => {
    expect(UiLocation.safeParse(location).success).toBe(true);
  });

  it.each([
    { page: 'team', taskKey: 'AR-1' },
    { page: 'board', view: 'thread' },
    { page: 'member' },
    { page: 'session' },
    { page: 'board', section: 'email' },
    { page: 'board', markId: 'fbm_abcdefghij' },
  ])('keeps a field to its own page: refuses %j', (location) => {
    expect(UiLocation.safeParse(location).success).toBe(false);
  });
});

describe('who may be offered a place', () => {
  it('shows the feedback and e-mail parts to the owner and the admin only', () => {
    expect(settingsSectionVisible('email', 'owner')).toBe(true);
    expect(settingsSectionVisible('feedback', 'admin')).toBe(true);
    expect(settingsSectionVisible('email', 'developer')).toBe(false);
    expect(settingsSectionVisible('labels', 'client')).toBe(true);
  });

  it('refuses a part the person does not see, and the machine-level parts for everyone', () => {
    expect(uiPlaceRefusal({ page: 'settings', section: 'email' }, 'developer')).toBe('place_not_visible');
    expect(uiPlaceRefusal({ page: 'settings', section: 'email' }, 'owner')).toBeNull();
    expect(uiPlaceRefusal({ page: 'settings', section: 'engines' }, 'owner')).toBe('place_not_target');
    expect(uiPlaceRefusal({ page: 'settings', section: 'integrator' }, 'admin')).toBe('place_not_target');
    expect(uiPlaceRefusal({ page: 'board' }, 'client')).toBeNull();
  });
});
