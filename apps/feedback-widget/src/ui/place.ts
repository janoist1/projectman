import type { Target } from '../controller';
import type { Point } from '../anchor';

/** Where the new-mark card hangs from: the marked place in viewport pixels, none for a whole-page mark. */
export function tipOfTarget(target: Target): Point | null {
  if (target.viewportPoint) return target.viewportPoint;
  if (target.viewportRect) return { x: target.viewportRect.x, y: target.viewportRect.y };
  return null;
}
