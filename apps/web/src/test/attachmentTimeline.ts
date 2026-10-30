import { screen } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import { t } from '../i18n/t';
import { openStory } from './cardStory';

/**
 * The story row "Csatolmány hozzáadva: <file>" (its file name is a link while the file exists,
 * so the row's text is in more than one element), after the card's Process tab is opened.
 * `scope` narrows the search, e.g. to a drawer.
 */
export async function findAddedRow(
  fileName: string,
  scope: Pick<BoundFunctions<typeof queries>, 'findByText' | 'findByRole' | 'queryByRole'> = screen,
): Promise<HTMLElement> {
  await openStory(scope);
  const text = `${t('timeline.attachmentAddedLead')} ${fileName}`;
  return scope.findByText((_content, node) => node?.tagName === 'SPAN' && node.textContent === text);
}
