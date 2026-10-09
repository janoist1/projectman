import type { FocusPlace } from '@projectman/shared';

/** A card's place in the project's focus (PM-437): `place 2 (via PM-390)`, or `place 1` for the item itself. */
export function focusPlaceText(place: FocusPlace): string {
  return `place ${place.position}${place.via ? ` (via ${place.via})` : ''}`;
}
