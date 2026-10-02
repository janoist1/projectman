import { describe, expect, it } from 'vitest';
import type { LabelView } from '@projectman/shared';
import { t } from '../i18n/t';
import { gateConditionText, unmetGateTexts } from './gates';

const labels = [
  { id: 'design-ok', name: 'Tervezői terv kész' },
  { id: 'ui', name: 'Felületi' },
] as unknown as LabelView[];

describe('gateConditionText', () => {
  it('names the label a condition is bound to, and only then', () => {
    expect(gateConditionText({ type: 'has_label', label: 'design-ok', when: 'ui' }, labels)).toBe(
      'Kell: Tervezői terv kész, ha Felületi',
    );
    expect(gateConditionText({ type: 'lacks_label', label: 'ui', when: 'design-ok' }, labels)).toBe(
      t('settings.pipeline.gateLacksLabelWhen', { label: 'Felületi', when: 'Tervezői terv kész' }),
    );
    expect(gateConditionText({ type: 'has_label', label: 'design-ok' }, labels)).toBe(
      t('settings.pipeline.gateHasLabel', { label: 'Tervezői terv kész' }),
    );
  });
});

describe('unmetGateTexts', () => {
  it('reads a conditional condition of a gate_blocked error, with the setters the server adds', () => {
    const details = {
      unmet: [
        {
          stageId: 'review',
          condition: { type: 'has_label', label: 'design-ok', when: 'ui' },
          setters: ['des'],
        },
      ],
    };
    expect(unmetGateTexts(details, labels)).toEqual(['Kell: Tervezői terv kész, ha Felületi']);
  });
});
