import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import type { InstancePauseView, PauseStatus } from '@projectman/shared';
import { useBoard, useInstancePause, useResumeInstance, useResumeProject } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toastContext';
import { formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { useDismiss, useIsMobile } from '../../lib/hooks';
import { PauseProgress, noPauseLookups, useProjectPauseLookups } from './PauseProgress';
import type { PauseLookups } from './PauseProgress';
import { isShutdownPause, reasonText, sinceText, stoppedCount, visiblePause } from './pauseView';
import styles from './PauseBanner.module.css';

/** Resumes a pause (project or instance) and says so; null while there is nothing to resume. */
function usePauseResume(pause: PauseStatus | null): { resume: () => void; resuming: boolean } {
  const toast = useToast();
  const project = useResumeProject(pause?.projectKey ?? '');
  const instance = useResumeInstance();
  const options = {
    onSuccess: () => toast.show(t('pause.toast.resumed'), 'ok'),
    onError: () => toast.show(t('pause.toast.resumeFailed'), 'error'),
  };
  const mutation = pause?.scope === 'instance' ? instance : project;
  return {
    resume: () =>
      pause?.scope === 'instance' ? instance.mutate(undefined, options) : project.mutate(undefined, options),
    resuming: mutation.isPending,
  };
}

function barTitle(pause: PauseStatus): string {
  if (isShutdownPause(pause)) return t('pause.banner.shutdown');
  if (pause.state === 'pausing') return t('pause.banner.pausing');
  return pause.scope === 'instance' ? t('pause.banner.instancePaused') : t('pause.banner.paused');
}

/** The grey text after the title: the count while pausing, else who and since when. */
function barMeta(pause: PauseStatus): string {
  if (isShutdownPause(pause)) return t('pause.banner.shutdownMeta');
  if (pause.state === 'pausing') {
    const { done, total } = stoppedCount(pause);
    return t('pause.banner.stoppedCount', { done, total });
  }
  const who = pause.requestedBy ?? (pause.scope === 'instance' ? reasonText(pause) : null);
  return [who, sinceText(pause.requestedAt)].filter(Boolean).join(' · ');
}

function BarText({ pause }: { pause: PauseStatus }) {
  const busy = pause.state === 'pausing' || isShutdownPause(pause);
  return (
    <span className={styles.text} role="status">
      {busy ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : (
        <Icon name="pause" size={16} strokeWidth={2.2} />
      )}
      <span className={styles.label}>{barTitle(pause)}</span>
      <span className={styles.meta}>{barMeta(pause)}</span>
    </span>
  );
}

/** The details: the progress, and the project's own pause when the instance's is the one the bar shows. */
function PauseDetails({
  pause,
  other,
  canManage,
  canLiftOther,
  lookups,
}: {
  pause: PauseStatus;
  other: PauseStatus | null;
  canManage: boolean;
  canLiftOther: boolean;
  lookups: PauseLookups;
}) {
  const lift = usePauseResume(other);
  return (
    <>
      <PauseProgress pause={pause} canManage={canManage} lookups={lookups} />
      {other ? (
        <p className={styles.other}>
          <span>
            {other.requestedBy
              ? t('pause.progress.projectAlso', {
                  who: other.requestedBy,
                  time: formatStamp(other.requestedAt),
                })
              : t('pause.progress.projectAlsoAnon', { time: formatStamp(other.requestedAt) })}
          </span>
          {canLiftOther ? (
            <Button variant="secondary" size="md" loading={lift.resuming} onClick={lift.resume}>
              {lift.resuming ? t('pause.progress.lifting') : t('pause.progress.lift')}
            </Button>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

/**
 * The bar over the page while a pause is open (PM-220): what is happening, Részletek and, for who may,
 * Folytatás. On a phone the whole bar is one button that opens the details as a sheet.
 */
export function PauseBar({
  pause,
  other = null,
  canManage,
  canLiftOther = false,
  lookups,
  autoOpen = false,
  openSignal = 0,
}: {
  pause: PauseStatus;
  /** The project's pause when the bar shows the instance's. */
  other?: PauseStatus | null;
  /** May resume and cut this pause. */
  canManage: boolean;
  canLiftOther?: boolean;
  lookups: PauseLookups;
  /** Open the details by themselves (the requester sees the progress at once). */
  autoOpen?: boolean;
  /** Opens the details each time it grows (another part of the page asks for them, PM-429). */
  openSignal?: number;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(autoOpen);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [triggerRef, panelRef], []);
  useDismiss(open && !isMobile, () => setOpen(false), refs, triggerRef);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen, pause.id]);
  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);
  // The details belong to the page they were opened on: a link in them, or any navigation, closes them.
  const { pathname } = useLocation();
  const openedAt = useRef(pathname);
  useEffect(() => {
    if (openedAt.current === pathname) return;
    openedAt.current = pathname;
    setOpen(false);
  }, [pathname]);
  const { resume, resuming } = usePauseResume(pause);
  const mayResume = canManage && !isShutdownPause(pause);
  const resumeLabel = resuming ? t('pause.banner.resuming') : t('pause.banner.resume');

  if (isMobile) {
    return (
      <div className={styles.wrap}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.phoneBar}
          aria-haspopup="dialog"
          aria-label={t('pause.banner.detailsOpen')}
          onClick={() => setOpen(true)}
        >
          <BarText pause={pause} />
          <Icon name="chevronRight" size={16} strokeWidth={2.2} />
        </button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          size="sm"
          title={barTitle(pause)}
          footer={
            <>
              <Button variant="secondary" size="xl" fullWidth onClick={() => setOpen(false)}>
                {t('pause.banner.close')}
              </Button>
              {mayResume ? (
                <Button variant="primary" size="xl" fullWidth loading={resuming} onClick={resume}>
                  {resumeLabel}
                </Button>
              ) : null}
            </>
          }
        >
          <PauseDetails
            pause={pause}
            other={other}
            canManage={canManage}
            canLiftOther={canLiftOther}
            lookups={lookups}
          />
        </Dialog>
      </div>
    );
  }

  return (
    <div className={open ? `${styles.wrap} ${styles.wrapOpen}` : styles.wrap}>
      <div className={styles.bar}>
        <BarText pause={pause} />
        <span className={styles.actions}>
          <button
            ref={triggerRef}
            type="button"
            className={`${styles.button} ${styles.detailsButton}`}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
          >
            {t('pause.banner.details')}
          </button>
          {mayResume ? (
            <button
              type="button"
              className={`${styles.button} ${styles.resume}`}
              disabled={resuming}
              onClick={resume}
            >
              {resumeLabel}
            </button>
          ) : null}
        </span>
      </div>
      {open ? (
        <div ref={panelRef} id={panelId} className={styles.panel}>
          <PauseDetails
            pause={pause}
            other={other}
            canManage={canManage}
            canLiftOther={canLiftOther}
            lookups={lookups}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The bar inside a project: the instance's pause when one is open (it wins), else the project's. The
 * requester's details open by themselves, and they hear when everyone has stopped.
 */
export function ProjectPauseBar({
  requestedPauseId,
  openSignal = 0,
}: {
  requestedPauseId: string | null;
  openSignal?: number;
}) {
  const { key, can } = useProject();
  const toast = useToast();
  const view = useBoard(key).data?.pause;
  const instance = useInstancePause(Boolean(view?.instance));
  const lookups = useProjectPauseLookups();
  const shown = visiblePause(view);

  // The requester hears when the last session has stopped.
  const state = shown?.pause.id === requestedPauseId ? shown?.pause.state : undefined;
  const lastState = useRef(state);
  useEffect(() => {
    if (lastState.current === 'pausing' && state === 'paused') toast.show(t('pause.toast.allStopped'), 'ok');
    lastState.current = state;
  }, [state, toast]);

  if (!shown) return null;
  const { pause, other } = shown;
  const instanceView: InstancePauseView | undefined = instance.data;
  const canManage = pause.scope === 'instance' ? Boolean(instanceView?.canManage) : can.pauseTeam;
  return (
    <PauseBar
      pause={pause}
      other={other}
      canManage={canManage}
      canLiftOther={can.pauseTeam}
      lookups={lookups}
      autoOpen={pause.id === requestedPauseId}
      openSignal={openSignal}
    />
  );
}

/** The instance's bar outside the projects, which have no websocket: the page asks every 15 seconds. */
export function InstancePauseBar() {
  const instance = useInstancePause(true, true);
  const pause = instance.data?.pause;
  if (!pause) return null;
  return <PauseBar pause={pause} canManage={instance.data?.canManage ?? false} lookups={noPauseLookups} />;
}
