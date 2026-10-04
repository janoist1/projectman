import { createContext, useContext } from 'react';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';

/** How an open card shows (PM-283): the quick view is the drawer, the large one a window over the board. */
export type CardSize = 'quick' | 'large';

/** The query parameter that makes the card open large; it lives in the address, so a link and a refresh keep it. */
export const SIZE_PARAM = 'size';

const CardSizeContext = createContext<CardSize>('quick');

export const CardSizeProvider = CardSizeContext.Provider;

export function useCardSize(): CardSize {
  return useContext(CardSizeContext);
}

/** A path to another card (or view of it) that opens in the size the open card has. */
export function withCardSize(path: string, size: CardSize): string {
  if (size === 'quick') return path;
  return `${path}${path.includes('?') ? '&' : '?'}${SIZE_PARAM}=large`;
}

/** The path of a card link inside the open card: a large window stays large when it leads to another card. */
export function useCardLink(): (path: string) => string {
  const size = useCardSize();
  return (path) => withCardSize(path, size);
}

/** The head's switch between the quick view and the large window; not shown (no `onToggle`) on a phone. */
export function CardSizeToggle({ size, onToggle }: { size: CardSize; onToggle: (() => void) | undefined }) {
  if (!onToggle) return null;
  const label = t(size === 'large' ? 'task.size.quick' : 'task.size.large');
  return (
    <Button
      variant="muted"
      iconOnly
      icon={size === 'large' ? 'collapse' : 'expand'}
      onClick={onToggle}
      aria-label={label}
      title={label}
    />
  );
}
