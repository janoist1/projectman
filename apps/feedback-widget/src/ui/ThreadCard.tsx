import type { Controller, State } from '../controller';
import { t } from '../i18n';
import { CloseButton, Dialog } from './Dialog';
import { useViewTick } from './hooks';
import { cardPlace } from './layout';
import { ThreadBody } from './ThreadBody';
import { personName } from './common';

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
  const mark = state.marks[markId];
  if (!mark) return null;
  const place = cardPlace(controller.viewportOf(mark), {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  return (
    <Dialog
      label={t('thread.titleOf', { name: personName(mark.author) })}
      kind="card"
      place={place}
      phone={phone}
    >
      <header class="card-head">
        <h2>{t('thread.titleOf', { name: personName(mark.author) })}</h2>
        <CloseButton label={t('thread.close')} onClick={() => controller.closeCard()} />
      </header>
      <ThreadBody controller={controller} state={state} mark={mark} />
    </Dialog>
  );
}
