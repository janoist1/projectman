import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '@projectman/shared';
import { t } from '../i18n/t';
import { describeEvent } from './timeline';
import { releaseStepName } from './release';

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const SHORT = COMMIT.slice(0, 8);
const context = { pipeline: null, members: new Map(), myHandle: 'owner', openInboxIds: new Set<string>() };
const key = 'timeline.events.release_changed';

function release(data: Record<string, unknown>): TimelineEvent {
  return {
    id: 'evt',
    projectKey: 'PM',
    taskKey: 'PM-9',
    sessionId: null,
    actor: { kind: 'human', handle: 'owner' },
    type: 'release_changed',
    data: { releaseId: 'rel_1', previousState: null, commit: COMMIT, ...data },
    createdAt: '2026-10-11T09:00:00.000Z',
  };
}
const describe_ = (data: Record<string, unknown>) => describeEvent(release(data), context);

describe('the release rows of the timeline (PM-492)', () => {
  it('says what was proposed, approved and started', () => {
    expect(describe_({ state: 'proposed' }).text).toBe(t(`${key}.proposed`, { commit: SHORT }));
    expect(describe_({ state: 'approved' }).text).toBe(t(`${key}.approved`));
    expect(describe_({ state: 'deploying' }).text).toBe(t(`${key}.deploying`, { commit: SHORT }));
  });

  it('shows the rejection reason as a note, and no note for an empty one', () => {
    const rejected = describe_({ state: 'rejected', note: '  Várjuk meg a PM-490-et.  ' });
    expect(rejected.text).toBe(t(`${key}.rejected`));
    expect(rejected.note).toBe('Várjuk meg a PM-490-et.');
    expect(describe_({ state: 'rejected', note: '   ' }).note).toBeUndefined();
    expect(describe_({ state: 'rejected' }).note).toBeUndefined();
  });

  it('names the step of a failure and what became of the old version', () => {
    const early = describe_({
      state: 'failed',
      failure: { step: 'build', message: 'tsc failed', rolledBack: false },
    });
    expect(early.text).toBe(
      t(`${key}.failed`, { step: releaseStepName('build'), outcome: t(`${key}.failedEarly`) }),
    );
    expect(early.detail).toBe('tsc failed');
    expect(early.emphasis).toBe('normal');

    const rolled = describe_({
      state: 'failed',
      failure: { step: 'verify', message: '', rolledBack: true },
    });
    expect(rolled.text).toContain(t(`${key}.failedRolledBack`));
    expect(rolled.detail).toBeUndefined();
    expect(rolled.emphasis).toBe('normal');

    const down = describe_({
      state: 'failed',
      failure: { step: 'switch', message: 'x', rolledBack: false },
    });
    expect(down.text).toContain(t(`${key}.failedDown`));
    expect(down.text).toContain(releaseStepName('switch'));
    expect(down.emphasis).toBe('needs');
  });

  it('falls back to the unknown row when the failure is missing', () => {
    expect(describe_({ state: 'failed' }).text).toBe(t(`${key}.unknown`, { commit: SHORT }));
  });

  it('says live, and flags a publish error', () => {
    expect(describe_({ state: 'live' }).text).toBe(t(`${key}.live`, { commit: SHORT }));
    const error = describe_({ state: 'live', publishError: 'HTTP 401' });
    expect(error.text).toBe(t(`${key}.livePublishError`));
    expect(error.detail).toBe('HTTP 401');
    expect(error.emphasis).toBe('needs');
  });

  it('shows the tag and the link of a published release, https only', () => {
    const published = describe_({
      state: 'published',
      tag: 'v1.4.0',
      url: 'https://github.com/acme/webshop/releases/tag/v1.4.0',
    });
    expect(published.text).toBe(t(`${key}.published`, { tag: 'v1.4.0' }));
    expect(published.link).toEqual({
      href: 'https://github.com/acme/webshop/releases/tag/v1.4.0',
      label: t(`${key}.githubRelease`),
    });
    expect(describe_({ state: 'published', tag: 'v1', url: 'javascript:alert(1)' }).link).toBeUndefined();
    expect(describe_({ state: 'published', tag: 'v1', url: 'http://example.com' }).link).toBeUndefined();
    expect(describe_({ state: 'published' }).text).toBe(t(`${key}.live`, { commit: SHORT }));
  });

  it('keeps an unknown state readable', () => {
    expect(describe_({ state: 'from_the_future' }).text).toBe(t(`${key}.unknown`, { commit: SHORT }));
  });
});
