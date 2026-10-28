import { describe, expect, it } from 'vitest';
import { collectorNotReadyText, startOfferText } from '.';

const base = { collector: false, waiting: [], toStageId: 'development', backStageId: 'incoming' };

describe('startOfferText (PM-804)', () => {
  it('names a self-contained card and what to do with it', () => {
    const text = startOfferText({
      ...base,
      subjectKey: 'PM-1',
      cards: [{ key: 'PM-1', title: 'Add the thing' }],
    });
    expect(text.split('\n')).toEqual([
      'Can start now: PM-1 "Add the thing".',
      'Move each to development with update_task (stage_id development); the system picks the developer. ' +
        'Skip a card only if a frame or focus lock holds it now. ' +
        "If the owner's comment holds a card, do not start it: open an integrator todo to move it back to incoming.",
    ]);
  });

  it('names the parts of a collector in order, and why the other parts wait', () => {
    const text = startOfferText({
      ...base,
      collector: true,
      subjectKey: 'PM-9',
      cards: [
        { key: 'PM-10', title: 'First' },
        { key: 'PM-11', title: 'Second' },
      ],
      waiting: [{ key: 'PM-12', why: 'waits for PM-10' }],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Parts of PM-9 can start now: PM-10 "First", PM-11 "Second" (in this order).');
    expect(lines[1]).toBe('The other parts wait: PM-12 (waits for PM-10).');
    expect(lines).toHaveLength(3);
  });

  it('never tells the receiver to pick the developer or to hand the card over', () => {
    const text = startOfferText({ ...base, subjectKey: 'PM-1', cards: [{ key: 'PM-1', title: 'A' }] });
    expect(text).toContain('the system picks the developer');
    expect(text).not.toMatch(/assign/i);
  });
});

describe('collectorNotReadyText (PM-804)', () => {
  it('says that none of the parts can start yet, and why', () => {
    expect(
      collectorNotReadyText({
        key: 'PM-9',
        parts: [
          { key: 'PM-10', why: 'waits for PM-5' },
          { key: 'PM-11', why: 'ready, waits (no_free_member)' },
        ],
      }),
    ).toBe(
      'PM-9 is worked out; none of its parts can start yet: PM-10 (waits for PM-5), PM-11 (ready, waits (no_free_member)). ' +
        'You get a message for each part when it can start.',
    );
  });
});
