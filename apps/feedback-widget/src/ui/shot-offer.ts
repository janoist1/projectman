import type { Draft } from '../controller';
import type { TextKey } from '../i18n/hu';

/**
 * What the new-mark card offers about the browser's screen-sharing picture, and what its status line
 * says (PM-921). Pure, so that every branch of the state table is tested without rendering.
 */
type BrowserOffer = 'none' | 'button' | 'link' | 'asking';

export function browserOffer(draft: Draft, canShare: boolean, sharing: boolean): BrowserOffer {
  if (!canShare) return 'none';
  const { shot } = draft;
  if (shot.browser === 'asking') return 'asking';
  // A good browser picture needs no other; a window or screen share may be chosen again.
  if (shot.status === 'ready' && shot.source === 'browser' && !shot.unmarked) return 'none';
  // With a share open the picture is on its way from there: nothing to offer for that moment.
  if (shot.status === 'pending') return sharing ? 'none' : 'link';
  return shot.status === 'failed' ? 'button' : 'link';
}

/** The key of the link's question: slow while the picture is being made, else "not good?". */
export const browserAskKey = (draft: Draft): TextKey =>
  draft.shot.status === 'pending' ? 'new.browserShotAskWait' : 'new.browserShotAskReady';

interface ShotNote {
  key: TextKey;
  /** The send goes on, but not with what the user asked for: the line is a warning. */
  warn: boolean;
}

export function shotNote(draft: Draft, canShare: boolean): ShotNote {
  const { shot } = draft;
  const refused = shot.browser === 'denied' ? 'Denied' : shot.browser === 'error' ? 'Error' : null;
  if (shot.status === 'failed') {
    if (refused) return { key: `new.browser${refused}None`, warn: true };
    return { key: canShare ? 'new.screenshotFailedOffer' : 'new.screenshotFailed', warn: false };
  }
  if (!draft.shotEnabled) return { key: 'new.screenshotOff', warn: false };
  if (shot.status === 'pending') return { key: 'new.screenshotWait', warn: false };
  if (shot.source === 'browser') {
    return { key: shot.unmarked ? 'new.shotFromWindow' : 'new.shotFromBrowser', warn: false };
  }
  if (refused) return { key: `new.browser${refused}Auto`, warn: true };
  return { key: 'new.screenshotOn', warn: false };
}
