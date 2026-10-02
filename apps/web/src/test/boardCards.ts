import { screen } from '@testing-library/react';
import { t } from '../i18n/t';

/**
 * Leaves out the links of the board's team strip: a chip names the card its member works on, so a
 * query by card title finds it as well as the card itself.
 */
export function withoutTeamStrip(links: readonly HTMLElement[]): HTMLElement[] {
  const strip = screen.queryByRole('region', { name: t('board.workingNow') });
  return links.filter((link) => !strip?.contains(link));
}

/** The cards of the board whose accessible name matches, found when they have rendered. */
export async function findBoardCardLinks(title: string): Promise<HTMLElement[]> {
  const links = await screen.findAllByRole('link', { name: new RegExp(title) });
  return withoutTeamStrip(links);
}
