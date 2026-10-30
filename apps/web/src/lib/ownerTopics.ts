import { APPROVAL_OWNER_TOPIC } from '@projectman/shared';
import type { OwnerTopic } from '@projectman/shared';
import { t, tDynamic } from '../i18n/t';

/**
 * An owner topic's name: approval's own, the project's label, a built-in topic's Hungarian name, otherwise
 * its id (a topic the project no longer lists).
 */
export function ownerTopicLabel(id: string, topics: readonly Pick<OwnerTopic, 'id' | 'label'>[]): string {
  if (id === APPROVAL_OWNER_TOPIC) return t('ownerTopics.approval');
  return topics.find((topic) => topic.id === id)?.label ?? tDynamic(`ownerTopics.builtIn.${id}.label`, id);
}
