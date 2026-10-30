import { fireEvent, screen, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import { t } from '../i18n/t';

type Scope = Pick<BoundFunctions<typeof queries>, 'findByRole' | 'queryByRole'>;

/**
 * Goes to one of the card's tabs. The controls of a tab that does not show are not reachable by role, so a
 * test that read one tab goes back to the other before it uses its controls again.
 */
export async function openTab(tab: 'card' | 'attachments' | 'steps', scope: Scope = screen): Promise<void> {
  const tabs = await scope.findByRole('group', { name: t('task.view.label') });
  fireEvent.click(within(tabs).getByRole('button', { name: new RegExp(`^${t(`task.view.${tab}`)}`) }));
}

/**
 * Opens the card's Process tab (PM-1160), where the story is read; `every` shows the system events too,
 * which the story folds away at first. `scope` narrows the search, e.g. to a drawer.
 */
export async function openStory(scope: Scope = screen, every = false): Promise<void> {
  await openTab('steps', scope);
  await scope.findByRole('heading', { name: new RegExp(`^${t('task.story.title')}`), level: 3 });
  if (!every) return;
  const choice = scope.queryByRole('group', { name: t('task.story.viewLabel') });
  if (choice) fireEvent.click(within(choice).getByRole('button', { name: t('task.story.view.all') }));
}
