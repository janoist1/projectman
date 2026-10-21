import { describe, expect, it } from 'vitest';
import { applyConfigPatch, PatchConfigRequest } from '../config/edit';
import type { MemberConfig, ProjectConfig } from '../config/schema';
import { FeedbackAnchor, FeedbackConfig, FeedbackSurface } from './feedback';
import {
  canMarkFeedback,
  canProcessFeedback,
  feedbackCardRef,
  feedbackLaunchUrl,
  feedbackMarkRefusal,
  feedbackOriginRefusal,
  normalizeFeedbackOrigin,
  planFeedbackAction,
} from './feedback-rules';
import type { FeedbackAction } from './feedback-rules';
import type { FeedbackOutcome, FeedbackStatus } from './feedback';

const human = (
  handle: string,
  access: 'owner' | 'admin' | 'developer' | 'client' | 'viewer',
  roles: string[] = [],
) => ({ kind: 'human', handle, displayName: handle, access, roles }) as MemberConfig;
const ai = (handle: string, role: string) =>
  ({ kind: 'ai', handle, displayName: handle, role, sponsor: 'owner' }) as unknown as MemberConfig;

function config(
  overrides: { surfaces?: { id: string; name: string; origin: string }[]; blocked?: string[] } = {},
) {
  return {
    project: {
      feedback: { surfaces: overrides.surfaces ?? [], blockedMarkers: overrides.blocked ?? [] },
    },
    team: { members: [], roles: [] },
  } as unknown as ProjectConfig;
}

describe('FeedbackAnchor', () => {
  const none = { selector: null, textSnippet: null, elementOffset: null, pagePoint: null, rect: null };
  const issuePaths = (anchor: unknown) => {
    const parsed = FeedbackAnchor.safeParse(anchor);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
  };

  it('needs the fields of its kind', () => {
    expect(issuePaths({ ...none, kind: 'point' })).toEqual(['pagePoint']);
    expect(issuePaths({ ...none, kind: 'point', pagePoint: { x: 1, y: 2 } })).toEqual([]);
    expect(issuePaths({ ...none, kind: 'area' })).toEqual(['rect']);
    expect(issuePaths({ ...none, kind: 'area', rect: { x: 0, y: 0, width: 3, height: 40 } })).toEqual([
      'rect',
    ]);
    expect(issuePaths({ ...none, kind: 'area', rect: { x: 0, y: 0, width: 4, height: 4 } })).toEqual([]);
    expect(issuePaths({ ...none, kind: 'element' })).toEqual(['selector', 'elementOffset', 'pagePoint']);
    expect(
      issuePaths({
        ...none,
        kind: 'element',
        selector: 'main > p',
        elementOffset: { x: 0.5, y: 1 },
        pagePoint: { x: 10, y: 20 },
      }),
    ).toEqual([]);
  });

  it('keeps a page mark free of coordinates', () => {
    expect(issuePaths({ ...none, kind: 'page' })).toEqual([]);
    expect(issuePaths({ ...none, kind: 'page', pagePoint: { x: 1, y: 1 } })).toEqual(['pagePoint']);
  });

  it('refuses fractions outside the element and unknown fields', () => {
    expect(
      issuePaths({
        ...none,
        kind: 'element',
        selector: 'a',
        elementOffset: { x: 1.5, y: 0 },
        pagePoint: { x: 1, y: 1 },
      }).length,
    ).toBeGreaterThan(0);
    expect(issuePaths({ ...none, kind: 'page', extra: 1 }).length).toBeGreaterThan(0);
  });

  describe('a point or an area pinned to an element (PM-917)', () => {
    const point = { ...none, kind: 'point', pagePoint: { x: 1, y: 2 } };
    const area = { ...none, kind: 'area', rect: { x: 1, y: 2, width: 40, height: 30 } };
    const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };

    it('accepts older marks that have no elementRect key', () => {
      expect(issuePaths(point)).toEqual([]);
      expect(issuePaths(area)).toEqual([]);
    });

    it('accepts a pinned point and a pinned area', () => {
      expect(issuePaths({ ...point, selector: 'main > p', elementOffset: { x: 0.2, y: 0.9 } })).toEqual([]);
      expect(issuePaths({ ...area, selector: 'main > p', elementRect: rect })).toEqual([]);
    });

    it.each([
      ['a point with a selector but no offset', { ...point, selector: 'p' }, ['elementOffset']],
      ['a point with an offset but no selector', { ...point, elementOffset: { x: 0, y: 0 } }, ['selector']],
      ['an area with a selector but no elementRect', { ...area, selector: 'p' }, ['elementRect']],
      ['an area with an elementRect but no selector', { ...area, elementRect: rect }, ['selector']],
      [
        'an elementRect that sticks out of the element',
        { ...area, selector: 'p', elementRect: { ...rect, x: 0.8 } },
        ['elementRect'],
      ],
      ['an elementRect on a point', { ...point, elementRect: rect }, ['elementRect']],
      [
        'an elementRect on an element mark',
        {
          ...none,
          kind: 'element',
          selector: 'p',
          elementOffset: { x: 0, y: 0 },
          pagePoint: { x: 1, y: 1 },
          elementRect: rect,
        },
        ['elementRect'],
      ],
    ])('refuses %s', (_label, anchor, paths) => {
      expect(issuePaths(anchor)).toEqual(paths);
    });
  });
});

describe('feedback surface addresses', () => {
  it('normalises scheme, host and port', () => {
    expect(normalizeFeedbackOrigin('HTTPS://Example.COM')).toBe('https://example.com');
    expect(normalizeFeedbackOrigin('https://example.com/')).toBe('https://example.com');
    expect(normalizeFeedbackOrigin('https://example.com:443')).toBe('https://example.com');
    expect(normalizeFeedbackOrigin('https://example.com:8443/')).toBe('https://example.com:8443');
    expect(normalizeFeedbackOrigin(' http://localhost:3000 ')).toBe('http://localhost:3000');
    expect(normalizeFeedbackOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(normalizeFeedbackOrigin('http://[::1]:8080')).toBe('http://[::1]:8080');
  });

  it('says why an address is refused', () => {
    expect(feedbackOriginRefusal('example.com')).toBe('not_url');
    expect(feedbackOriginRefusal('')).toBe('not_url');
    expect(feedbackOriginRefusal('https://user:pw@example.com')).toBe('not_url');
    expect(feedbackOriginRefusal('ftp://example.com')).toBe('bad_scheme');
    expect(feedbackOriginRefusal('http://example.com')).toBe('bad_scheme');
    expect(feedbackOriginRefusal('https://example.com/app')).toBe('has_path');
    expect(feedbackOriginRefusal('https://example.com?x=1')).toBe('has_path');
    expect(feedbackOriginRefusal('https://example.com#top')).toBe('has_path');
    expect(feedbackOriginRefusal('https://example.com/#')).toBe('has_path');
    expect(feedbackOriginRefusal('https://example.com/')).toBeNull();
    expect(feedbackOriginRefusal('http://localhost')).toBeNull();
    expect(normalizeFeedbackOrigin('https://example.com/app')).toBeNull();
  });

  it('builds the launch address with the code in the fragment, or in the query when the page has a hash', () => {
    expect(feedbackLaunchUrl('https://example.com/', 'abc')).toBe('https://example.com/#pm-feedback=abc');
    expect(feedbackLaunchUrl('https://example.com/a?b=1', 'abc', 'fbm_x')).toBe(
      'https://example.com/a?b=1#pm-feedback=abc&pm-feedback-mark=fbm_x',
    );
    expect(feedbackLaunchUrl('https://example.com/#/page', 'abc')).toBe(
      'https://example.com/?pm-feedback=abc#/page',
    );
    expect(feedbackLaunchUrl('https://example.com/?a=1#/page', 'abc', 'fbm_x')).toBe(
      'https://example.com/?a=1&pm-feedback=abc&pm-feedback-mark=fbm_x#/page',
    );
  });
});

describe('feedback configuration', () => {
  it('defaults to nothing set up and refuses a bad surface', () => {
    expect(FeedbackConfig.parse({})).toEqual({ surfaces: [], blockedMarkers: [] });
    expect(FeedbackSurface.safeParse({ id: 'web', name: 'Site', origin: 'https://a.example' }).success).toBe(
      true,
    );
    expect(
      FeedbackSurface.safeParse({ id: 'web', name: 'Site', origin: 'https://a.example/x' }).success,
    ).toBe(false);
    expect(FeedbackSurface.safeParse({ id: 'Web', name: 'Site', origin: 'https://a.example' }).success).toBe(
      false,
    );
    expect(
      FeedbackConfig.safeParse({
        surfaces: Array.from({ length: 21 }, (_, i) => ({
          id: `s${i}`,
          name: 'n',
          origin: `https://s${i}.example`,
        })),
      }).success,
    ).toBe(false);
  });

  it('applies a patch as a whole list and normalises the addresses', () => {
    const base = {
      project: { key: 'AR', feedback: { surfaces: [], blockedMarkers: ['x'] } },
      team: { members: [], limits: { tempWorkers: {} } },
      pipeline: {},
    } as unknown as ProjectConfig;
    const patched = applyConfigPatch(base, {
      baseVersion: 'v',
      feedback: { surfaces: [{ id: 'web', name: 'Site', origin: 'HTTPS://A.example/' }] },
    });
    expect(patched.project.feedback).toEqual({
      surfaces: [{ id: 'web', name: 'Site', origin: 'https://a.example' }],
      blockedMarkers: ['x'],
    });
    const blocked = applyConfigPatch(patched, { baseVersion: 'v', feedback: { blockedMarkers: [] } });
    expect(blocked.project.feedback?.blockedMarkers).toEqual([]);
    expect(blocked.project.feedback?.surfaces).toHaveLength(1);
  });

  it('keeps the list the request leaves out, once parsed', () => {
    const surface = { id: 'web', name: 'Site', origin: 'https://a.example' };
    const base = {
      project: { key: 'AR', feedback: { surfaces: [surface], blockedMarkers: ['x'] } },
      team: { members: [], limits: { tempWorkers: {} } },
      pipeline: {},
    } as unknown as ProjectConfig;
    const onlyBlocked = PatchConfigRequest.parse({
      baseVersion: 'v',
      feedback: { blockedMarkers: ['kata'] },
    });
    expect(onlyBlocked.feedback).toEqual({ blockedMarkers: ['kata'] });
    expect(applyConfigPatch(base, onlyBlocked).project.feedback).toEqual({
      surfaces: [surface],
      blockedMarkers: ['kata'],
    });
    const onlySurfaces = PatchConfigRequest.parse({ baseVersion: 'v', feedback: { surfaces: [] } });
    expect(onlySurfaces.feedback).toEqual({ surfaces: [] });
    expect(applyConfigPatch(base, onlySurfaces).project.feedback).toEqual({
      surfaces: [],
      blockedMarkers: ['x'],
    });
  });
});

describe('who processes and who marks', () => {
  const c = {
    ...config({ surfaces: [{ id: 'web', name: 'Site', origin: 'https://a.example' }], blocked: ['blocked'] }),
    team: { members: [], roles: [] },
  } as unknown as ProjectConfig;

  it('lets the holder of the duty and a human owner or admin process', () => {
    expect(canProcessFeedback(c, ai('pm', 'project_manager'))).toBe(true);
    expect(canProcessFeedback(c, human('o', 'owner'))).toBe(true);
    expect(canProcessFeedback(c, human('a', 'admin'))).toBe(true);
    expect(canProcessFeedback(c, human('d', 'developer'))).toBe(false);
    expect(canProcessFeedback(c, human('d', 'developer', ['project_manager']))).toBe(true);
    expect(canProcessFeedback(c, ai('dev', 'developer'))).toBe(false);
    expect(canProcessFeedback(c, human('cl', 'client'))).toBe(false);
  });

  it('gives the reason a member may not mark', () => {
    expect(feedbackMarkRefusal(c, ai('pm', 'project_manager'))).toBe('not_human');
    expect(feedbackMarkRefusal(c, human('v', 'viewer'))).toBe('viewer');
    expect(feedbackMarkRefusal(c, human('blocked', 'client'))).toBe('blocked');
    expect(feedbackMarkRefusal(config(), human('cl', 'client'))).toBe('no_surface');
    expect(feedbackMarkRefusal(c, human('cl', 'client'))).toBeNull();
    expect(canMarkFeedback(c, human('d', 'developer'))).toBe(true);
    expect(canMarkFeedback(c, human('v', 'viewer'))).toBe(false);
  });
});

describe('feedbackCardRef', () => {
  const internal = { key: 'AR-1', title: 'Secret plan', visibility: 'internal' as const };
  const shared = { key: 'AR-2', title: 'Shared work', visibility: 'shared' as const };

  it('shows an internal card to everyone but a client', () => {
    expect(feedbackCardRef(internal, 'Fejlesztés', 'developer')).toEqual({
      visible: true,
      key: 'AR-1',
      title: 'Secret plan',
      stageName: 'Fejlesztés',
      visibility: 'internal',
    });
    expect(feedbackCardRef(internal, 'Fejlesztés', 'ai').visible).toBe(true);
    expect(feedbackCardRef(internal, 'Fejlesztés', 'client')).toEqual({ visible: false });
  });

  it('shows a shared card to a client', () => {
    expect(feedbackCardRef(shared, 'Kész', 'client')).toMatchObject({ visible: true, key: 'AR-2' });
  });
});

describe('planFeedbackAction', () => {
  type Mark = {
    status: FeedbackStatus;
    outcome: FeedbackOutcome | null;
    taskKey: string | null;
    author: string;
  };
  const mark = (status: FeedbackStatus, extra: Partial<Mark> = {}): Mark => ({
    status,
    outcome: null,
    taskKey: null,
    author: 'cl',
    ...extra,
  });
  const processorAi = { handle: 'pm', kind: 'ai' as const, processor: true };
  const processorHuman = { handle: 'o', kind: 'human' as const, processor: true };
  const marker = { handle: 'cl', kind: 'human' as const, processor: false };
  const plan = (m: Mark, action: FeedbackAction, actor: Parameters<typeof planFeedbackAction>[2]) =>
    planFeedbackAction(m, action, actor);

  it('comments of a processor settle the mark', () => {
    expect(plan(mark('new'), 'comment', processorAi)).toEqual({
      status: 'handled',
      outcome: 'answered',
      clearHanded: true,
      wakeProcessor: false,
    });
    expect(
      plan(mark('handled', { outcome: 'card_created', taskKey: 'AR-3' }), 'comment', processorAi),
    ).toMatchObject({
      status: 'handled',
      outcome: 'card_created',
    });
    expect(plan(mark('waiting_owner'), 'comment', processorHuman)).toMatchObject({
      status: 'handled',
      outcome: 'answered',
    });
    expect(plan(mark('waiting_owner'), 'comment', processorAi)).toMatchObject({
      status: 'waiting_owner',
      outcome: null,
      clearHanded: true,
    });
    expect(plan(mark('closed'), 'comment', processorAi)).toEqual({ refused: 'feedback_closed' });
  });

  it('comments of anyone else reopen the talk and wake the processor', () => {
    expect(plan(mark('handled', { outcome: 'answered' }), 'comment', marker)).toEqual({
      status: 'new',
      outcome: 'answered',
      clearHanded: false,
      wakeProcessor: true,
    });
    expect(plan(mark('new'), 'comment', marker)).toMatchObject({ status: 'new', wakeProcessor: true });
    expect(plan(mark('waiting_owner'), 'comment', marker)).toMatchObject({ status: 'waiting_owner' });
    expect(plan(mark('closed'), 'comment', marker)).toEqual({ refused: 'feedback_closed' });
  });

  it("treats a processor's comment on their own mark as the marker's", () => {
    expect(plan(mark('handled', { author: 'o' }), 'comment', processorHuman)).toMatchObject({
      status: 'new',
      wakeProcessor: true,
      clearHanded: false,
    });
  });

  it('opens a card or links one only once for a new card, and not for an AI on a forwarded mark', () => {
    expect(plan(mark('new'), 'create_task', processorAi)).toEqual({
      status: 'handled',
      outcome: 'card_created',
      clearHanded: true,
      wakeProcessor: false,
    });
    expect(plan(mark('new', { taskKey: 'AR-3' }), 'create_task', processorAi)).toEqual({
      refused: 'feedback_task_exists',
    });
    expect(plan(mark('waiting_owner'), 'create_task', processorAi)).toEqual({
      refused: 'feedback_waiting_owner',
    });
    expect(plan(mark('waiting_owner'), 'create_task', processorHuman)).toMatchObject({ status: 'handled' });
    expect(plan(mark('handled', { taskKey: 'AR-3' }), 'link', processorAi)).toMatchObject({
      status: 'handled',
      outcome: 'card_linked',
    });
    expect(plan(mark('waiting_owner'), 'link', processorAi)).toEqual({ refused: 'feedback_waiting_owner' });
    expect(plan(mark('closed'), 'link', processorAi)).toEqual({ refused: 'feedback_closed' });
    expect(plan(mark('new'), 'create_task', marker)).toEqual({ refused: 'feedback_processor_only' });
    expect(plan(mark('new'), 'link', marker)).toEqual({ refused: 'feedback_processor_only' });
  });

  it('forwards only from an AI processor, from new or handled', () => {
    expect(plan(mark('new'), 'forward', processorAi)).toEqual({
      status: 'waiting_owner',
      outcome: null,
      clearHanded: true,
      wakeProcessor: false,
    });
    expect(plan(mark('handled', { outcome: 'answered' }), 'forward', processorAi)).toMatchObject({
      status: 'waiting_owner',
      outcome: 'answered',
    });
    expect(plan(mark('waiting_owner'), 'forward', processorAi)).toEqual({
      refused: 'feedback_waiting_owner',
    });
    expect(plan(mark('closed'), 'forward', processorAi)).toEqual({ refused: 'feedback_closed' });
    expect(plan(mark('new'), 'forward', processorHuman)).toEqual({ refused: 'feedback_processor_only' });
    expect(plan(mark('new'), 'forward', marker)).toEqual({ refused: 'feedback_processor_only' });
  });

  it('closes unless closed, and not an AI on a forwarded mark', () => {
    expect(plan(mark('new'), 'close', processorAi)).toMatchObject({ status: 'closed', clearHanded: true });
    expect(plan(mark('handled', { outcome: 'answered' }), 'close', processorHuman)).toMatchObject({
      status: 'closed',
      outcome: 'answered',
    });
    expect(plan(mark('waiting_owner'), 'close', processorAi)).toEqual({ refused: 'feedback_waiting_owner' });
    expect(plan(mark('waiting_owner'), 'close', processorHuman)).toMatchObject({ status: 'closed' });
    expect(plan(mark('closed'), 'close', processorAi)).toEqual({ refused: 'feedback_closed' });
    expect(plan(mark('new'), 'close', marker)).toEqual({ refused: 'feedback_processor_only' });
  });

  it('reopens a closed mark to handled when it has a card or an outcome, else to new', () => {
    expect(
      plan(mark('closed', { taskKey: 'AR-3', outcome: 'card_created' }), 'reopen', processorHuman),
    ).toMatchObject({
      status: 'handled',
      outcome: 'card_created',
    });
    expect(plan(mark('closed', { outcome: 'answered' }), 'reopen', processorAi)).toMatchObject({
      status: 'handled',
    });
    expect(plan(mark('closed'), 'reopen', processorAi)).toMatchObject({ status: 'new', outcome: null });
    expect(plan(mark('new'), 'reopen', processorAi)).toEqual({ refused: 'feedback_not_closed' });
    expect(plan(mark('closed'), 'reopen', marker)).toEqual({ refused: 'feedback_processor_only' });
  });
});
