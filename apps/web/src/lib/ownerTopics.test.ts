import { expect, it } from 'vitest';
import { MockBackend } from '../mocks/backend';
import { t } from '../i18n/t';
import { newOwnerTopicId, ownerTopicLabel } from './ownerTopics';

it('resolves configured labels, approvals, built-ins and deleted topics', () => {
  const config = new MockBackend().config;
  config.team.ownerDecisionTopics = [
    { id: 'cost', label: 'Budget' },
    { id: 'legal', label: 'Legal', hint: 'Contracts' },
  ];
  expect(ownerTopicLabel('cost', config)).toBe('Budget');
  expect(ownerTopicLabel('legal', config)).toBe('Legal');
  expect(ownerTopicLabel('approval', config)).toBe(t('ownerTopics.approval'));
  expect(ownerTopicLabel('product_direction', config)).toBe(t('ownerTopics.builtIn.product_direction.label'));
  expect(ownerTopicLabel('deleted', config)).toBe('deleted');
});

it.each([
  ['Jogi kérdés', [], 'jogi_kerdes'],
  ['123', [], 'topic_123'],
  ['!!!', [], 'topic'],
  ['cost', ['cost_2'], 'cost_3'],
  ['approval', [], 'approval_2'],
  ['a'.repeat(60), ['a'.repeat(40)], `${'a'.repeat(38)}_2`],
] as const)('creates an unoccupied bounded id for %s', (label, existing, expected) => {
  expect(newOwnerTopicId(label, existing)).toBe(expected);
});
