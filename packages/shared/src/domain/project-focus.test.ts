import { describe, expect, it } from 'vitest';
import { ProjectConfig } from '../config/schema';
import {
  ProjectFocus,
  PROJECT_FOCUS_MAX_ITEMS,
  projectFocusPlaces,
  projectFocusRefusal,
} from './project-focus';
import type { Task } from './task';

const config = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
  team: {
    members: [
      { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
      { kind: 'human', handle: 'po', displayName: 'PO', access: 'developer', roles: ['product_owner'] },
      { kind: 'human', handle: 'dev', displayName: 'Dev', access: 'developer', roles: ['developer'] },
      { kind: 'ai', handle: 'pm-ai', displayName: 'AI PO', role: 'product_owner', sponsor: 'owner' },
    ],
    limits: {},
  },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'ideas', name: 'Ideas', kind: 'queue', columnId: 'all' },
      { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
    ],
    labels: [],
  },
});

describe('projectFocusRefusal', () => {
  it('allows the owner and a person who prioritizes, the integrator included', () => {
    expect(projectFocusRefusal(config, { kind: 'human', handle: 'owner' })).toBeNull();
    expect(projectFocusRefusal(config, { kind: 'human', handle: 'po' })).toBeNull();
    expect(projectFocusRefusal(config, { kind: 'human', handle: 'owner', via: 'integrator' })).toBeNull();
  });
  it('refuses any other person', () => {
    expect(projectFocusRefusal(config, { kind: 'human', handle: 'dev' })).toBe('focus_not_allowed');
    expect(projectFocusRefusal(config, { kind: 'human', handle: 'ghost' })).toBe('focus_not_allowed');
    expect(projectFocusRefusal(config, { kind: 'human', handle: null })).toBe('focus_not_allowed');
  });
  it('refuses an AI member and the system, even one that prioritizes', () => {
    expect(projectFocusRefusal(config, { kind: 'ai', handle: 'pm-ai' })).toBe('focus_humans_only');
    expect(projectFocusRefusal(config, { kind: 'ai', handle: 'owner' })).toBe('focus_humans_only');
    expect(projectFocusRefusal(config, { kind: 'system', handle: null })).toBe('focus_humans_only');
  });
});

const task = (key: string, extra: Partial<Task> = {}): Task =>
  ({ key, status: 'active', kind: 'task', parentKey: null, themeKey: null, ...extra }) as Task;
const items = (...keys: string[]) => keys.map((key) => ({ key }));

describe('projectFocusPlaces', () => {
  it('lets a card cover itself and its subtasks', () => {
    const places = projectFocusPlaces(items('AC-1'), [
      task('AC-1'),
      task('AC-2', { parentKey: 'AC-1' }),
      task('AC-3'),
    ]);
    expect(places.get('AC-1')).toEqual({ position: 1 });
    expect(places.get('AC-2')).toEqual({ position: 1, via: 'AC-1' });
    expect(places.has('AC-3')).toBe(false);
  });
  it('lets a theme cover itself, its cards and their subtasks', () => {
    const places = projectFocusPlaces(items('AC-9', 'AC-1'), [
      task('AC-9', { kind: 'theme' }),
      task('AC-1', { themeKey: 'AC-9' }),
      task('AC-2', { parentKey: 'AC-1', themeKey: 'AC-9' }),
      // A subtask whose theme is not filled in reads its parent's.
      task('AC-4', { parentKey: 'AC-1' }),
      task('AC-5'),
    ]);
    expect(places.get('AC-9')).toEqual({ position: 1 });
    expect(places.get('AC-1')).toEqual({ position: 1, via: 'AC-9' });
    expect(places.get('AC-2')).toEqual({ position: 1, via: 'AC-9' });
    expect(places.get('AC-4')).toEqual({ position: 1, via: 'AC-9' });
    expect(places.has('AC-5')).toBe(false);
  });
  it('gives a card covered twice the smaller place', () => {
    const places = projectFocusPlaces(items('AC-1', 'AC-9'), [
      task('AC-9', { kind: 'theme' }),
      task('AC-1', { themeKey: 'AC-9' }),
      task('AC-2', { themeKey: 'AC-9' }),
    ]);
    expect(places.get('AC-1')).toEqual({ position: 1 });
    expect(places.get('AC-2')).toEqual({ position: 2, via: 'AC-9' });
    expect(places.get('AC-9')).toEqual({ position: 2 });
  });
  it('covers nothing with a closed item, but the closed item still takes its number', () => {
    const places = projectFocusPlaces(items('AC-9', 'AC-1', 'AC-8'), [
      task('AC-9', { kind: 'theme', status: 'cancelled' }),
      task('AC-3', { themeKey: 'AC-9' }),
      task('AC-1', { status: 'done' }),
      task('AC-2', { parentKey: 'AC-1' }),
      task('AC-8'),
    ]);
    expect(places.has('AC-9')).toBe(false);
    expect(places.has('AC-3')).toBe(false);
    expect(places.has('AC-2')).toBe(false);
    expect(places.get('AC-8')).toEqual({ position: 3 });
  });
  it('gives a closed card no place, and ignores an item whose card is unknown', () => {
    const places = projectFocusPlaces(items('GONE-1', 'AC-9'), [
      task('AC-9', { kind: 'theme' }),
      task('AC-1', { themeKey: 'AC-9', status: 'done' }),
      task('AC-2', { themeKey: 'AC-9' }),
    ]);
    expect(places.has('AC-1')).toBe(false);
    expect(places.get('AC-2')).toEqual({ position: 2, via: 'AC-9' });
    expect(places.has('GONE-1')).toBe(false);
  });
});

describe('ProjectFocus', () => {
  const item = {
    key: 'AC-1',
    addedAt: '2026-10-09T10:00:00.000Z',
    addedBy: { kind: 'human', handle: 'owner' },
  };
  it('holds at most the maximum number of items', () => {
    const full = Array.from({ length: PROJECT_FOCUS_MAX_ITEMS }, () => item);
    expect(ProjectFocus.safeParse({ items: full }).success).toBe(true);
    expect(ProjectFocus.safeParse({ items: [...full, item] }).success).toBe(false);
  });
});
