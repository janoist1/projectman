import { screen } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import { t } from '../i18n/t';

/**
 * The timeline row "Csatolmány hozzáadva: <file>" (its file name is a link while the file exists,
 * so the row's text is in more than one element). `scope` narrows the search, e.g. to a drawer.
 */
export function findAddedRow(
  fileName: string,
  scope: Pick<BoundFunctions<typeof queries>, 'findByText'> = screen,
): Promise<HTMLElement> {
  const text = `${t('timeline.attachmentAddedLead')} ${fileName}`;
  return scope.findByText((_content, node) => node?.tagName === 'SPAN' && node.textContent === text);
}
