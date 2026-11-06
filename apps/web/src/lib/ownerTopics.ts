import { DEFAULT_OWNER_DECISION_TOPICS } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { t, tDynamic } from '../i18n/t';

export const builtInOwnerTopicIds = DEFAULT_OWNER_DECISION_TOPICS.map(({ id }) => id);

export function ownerTopicLabel(id: string, config?: Pick<ProjectConfig, 'team'>): string {
  if (id === 'approval') return t('ownerTopics.approval');
  const label = config?.team.ownerDecisionTopics?.find((topic) => topic.id === id)?.label;
  if (label) return label;
  const builtIn = builtInOwnerTopicIds.find((value) => value === id);
  return builtIn ? tDynamic(`ownerTopics.builtIn.${builtIn}.label`, id) : id;
}

export function newOwnerTopicId(label: string, existing: readonly string[]): string {
  let base = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = `topic_${base}`;
  base = base.slice(0, 40).replace(/_+$/g, '');
  const reserved = new Set([...existing, ...builtInOwnerTopicIds, 'approval']);
  let id = base;
  for (let suffix = 2; reserved.has(id); suffix += 1) {
    const tail = `_${suffix}`;
    id = `${base.slice(0, 40 - tail.length)}${tail}`;
  }
  return id;
}
