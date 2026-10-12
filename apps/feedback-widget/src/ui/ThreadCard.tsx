import { useEffect, useRef } from 'preact/hooks';
import type { Controller, State } from '../controller';
import { t } from '../i18n';
import { CloseButton, Dialog } from './Dialog';
import { useViewTick } from './hooks';
import { cardPlace, pinClearance, revealScroll } from './layout';
import { ThreadBody } from './ThreadBody';
import { colorVar, personName } from './common';

/** A pinned mark's thread, next to its pin (a bottom sheet on a phone). */
export function ThreadCard({
  controller,
  state,
  markId,
  phone,
}: {
  controller: Controller;
  state: State;
  markId: string;
  phone: boolean;
}) {
  useViewTick(true); // the card follows its pin when the page scrolls
  const root = useRef<HTMLDivElement>(null);
  const mark = state.marks[markId];
  const threadStatus = state.threads[markId]?.status;

  // On a phone the sheet covers the bottom of the page: scroll so the pin shows above it.
  useEffect(() => {
    const sheet = root.current;
    const found = mark ? controller.viewportOf(mark) : null;
    if (!phone || !sheet || !found) return;
    const delta = revealScroll(found.y, sheet.getBoundingClientRect().top);
    if (delta !== 0) window.scrollBy({ top: delta, behavior: 'auto' });
  }, [controller, markId, phone, threadStatus]);

  if (!mark) return null;
  const name = personName(mark.author);
  const place = cardPlace(
    controller.viewportOf(mark),
    { width: window.innerWidth, height: window.innerHeight },
    pinClearance(name),
  );
  return (
    <Dialog label={t('thread.titleOf', { name })} kind="card" place={place} phone={phone} rootRef={root}>
      <div class="bar" style={{ '--pc': colorVar(mark.author) }} aria-hidden="true" />
      <header class="card-head">
        <h2>{t('thread.titleOf', { name })}</h2>
        <CloseButton label={t('thread.close')} onClick={() => controller.closeCard()} />
      </header>
      <ThreadBody controller={controller} state={state} mark={mark} />
    </Dialog>
  );
}
