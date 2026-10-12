import type { FeedbackMarkView } from '@projectman/shared';
import { groupForPanel } from '../anchor';
import type { Controller, State } from '../controller';
import { t } from '../i18n';
import { relativeTime } from '../time';
import { CloseButton, Dialog } from './Dialog';
import { Avatar, StatusLabel, colorVar, personName } from './common';
import { ThreadBody } from './ThreadBody';

/** Open marks first, then closed ones; the most recent activity first within each. */
const byActivity = (a: FeedbackMarkView, b: FeedbackMarkView): number => {
  const closed = Number(a.status === 'closed') - Number(b.status === 'closed');
  return closed !== 0 ? closed : b.lastActivityAt.localeCompare(a.lastActivityAt);
};

function Row({ controller, mark, showPage }: { controller: Controller; mark: FeedbackMarkView; showPage: boolean }) {
  const now = Date.now();
  return (
    <li>
      <button
        type="button"
        class={`row${mark.status === 'closed' ? ' closed' : ''}`}
        style={{ '--pc': colorVar(mark.author) }}
        onClick={() => controller.openMark(mark.id)}
      >
        <Avatar person={mark.author} />
        <span class="row-main">
          <span class="row-head">
            <span class="kind">{t(`kind.${mark.kind}`)}</span>
            <b>{personName(mark.author)}</b>
            <time dateTime={mark.lastActivityAt}>{relativeTime(mark.lastActivityAt, now)}</time>
          </span>
          <span class="row-body">{mark.body}</span>
          <span class="row-foot">
            <StatusLabel mark={mark} />
            {mark.commentCount > 0 && <span>{t('thread.commentCount', { count: mark.commentCount })}</span>}
            {showPage && <span class="row-page">{mark.pagePath}</span>}
          </span>
        </span>
        {mark.unread && <i class="unread" aria-hidden="true" />}
      </button>
    </li>
  );
}

function Group({
  title,
  hint,
  marks,
  controller,
  showPage,
}: {
  title: string;
  hint?: string;
  marks: FeedbackMarkView[];
  controller: Controller;
  showPage: boolean;
}) {
  if (marks.length === 0) return null;
  return (
    <section class="group">
      <h3>{title}</h3>
      {hint && <p class="group-hint">{hint}</p>}
      <ul>
        {[...marks].sort(byActivity).map((mark) => (
          <Row key={mark.id} controller={controller} mark={mark} showPage={showPage} />
        ))}
      </ul>
    </section>
  );
}

export function Panel({ controller, state, phone }: { controller: Controller; state: State; phone: boolean }) {
  const panel = state.panel;
  if (!panel) return null;
  const all = Object.values(state.marks);
  const here = all.filter((mark) => controller.isOnThisPage(mark));
  const open = panel.markId ? state.marks[panel.markId] : null;
  const groups = groupForPanel(here, (mark) => controller.resolutionOf(mark));
  const shown = panel.tab === 'here' ? here : all;

  return (
    <Dialog label={t('panel.title')} kind="panel" phone={phone}>
      <header class="card-head">
        <h2>{t('panel.title')}</h2>
        <CloseButton label={t('panel.close')} onClick={() => controller.closePanel()} />
      </header>
      {open ? (
        <>
          <button type="button" class="back" onClick={() => controller.panelBack()}>
            {t('panel.back')}
          </button>
          <ThreadBody controller={controller} state={state} mark={open} />
        </>
      ) : (
        <>
          <div class="tabs" role="tablist" aria-label={t('panel.title')}>
            {(['here', 'all'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                class="tab"
                aria-selected={panel.tab === tab}
                onClick={() => controller.setTab(tab)}
              >
                {t(tab === 'here' ? 'panel.tabHere' : 'panel.tabAll')}
              </button>
            ))}
          </div>
          <div class="list" role="tabpanel">
            {shown.length === 0 ? (
              <p class="empty">{t(panel.tab === 'here' ? 'panel.empty' : 'panel.emptyAll')}</p>
            ) : panel.tab === 'here' ? (
              <>
                <Group title={t('panel.pageGroup')} marks={groups.page} controller={controller} showPage={false} />
                <Group title={t('panel.marksGroup')} marks={groups.pinned} controller={controller} showPage={false} />
                <Group
                  title={t('panel.lostGroup')}
                  hint={t('panel.lostHint')}
                  marks={groups.lost}
                  controller={controller}
                  showPage={false}
                />
              </>
            ) : (
              <Group title={t('panel.marksGroup')} marks={all} controller={controller} showPage />
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
