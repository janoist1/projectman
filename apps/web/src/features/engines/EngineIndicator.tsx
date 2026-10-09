import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import type { EngineStatusView } from '@projectman/shared';
import { useEngines, useEngineStatus, useMe } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { useMediaQuery } from '../../lib/hooks';
import { useNow } from '../../lib/useNow';
import { defaultEngine, defaultFirst, engineState, statusText, workText } from './engineView';
import styles from './Engines.module.css';

/**
 * The AI engine's state in the top bar (PM-316). Quiet while the default engine is connected; shown
 * only in cloud mode and only to members who work inside the project (a client is refused by the server).
 */
export function EngineIndicator({ phone = false }: { phone?: boolean }) {
  const status = useEngineStatus();
  const isPhone = useMediaQuery('(max-width: 767px)');
  if (status.data?.mode !== 'cloud' || status.isError || phone !== isPhone) return null;
  return <CloudIndicator engines={status.data.engines} phone={phone} />;
}

function CloudIndicator({ engines, phone }: { engines: EngineStatusView[]; phone: boolean }) {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const badge = useMediaQuery('(max-width: 1279px)');
  const now = new Date(useNow(true, 30_000));
  const button = useRef<HTMLButtonElement>(null);
  const known = useRef<Map<string, boolean> | null>(null);
  const id = useId();
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);

  // A change of a connection is announced once, not the first state.
  useEffect(() => {
    const before = known.current;
    known.current = new Map(engines.map((engine) => [engine.id, engine.online]));
    if (!before) return;
    for (const engine of engines) {
      const was = before.get(engine.id);
      if (was !== undefined && was !== engine.online)
        setAnnouncement(
          t(engine.online ? 'engines.announceOnline' : 'engines.announceOffline', { name: engine.name }),
        );
    }
  }, [engines]);

  const main = defaultEngine(engines);
  const state = !main ? 'none' : main.online ? 'online' : 'offline';
  const trouble = state !== 'online';
  const live = (
    <span role="status" className="visually-hidden">
      {announcement}
    </span>
  );
  // On a phone only a problem takes room in the header.
  if (phone && !trouble) return live;

  const text = engines.length === 0 ? t('engines.none') : !main ? t('engines.noDefault') : main.name;
  const label =
    engines.length === 0
      ? t('engines.labelNone')
      : !main
        ? t('engines.labelNoDefault')
        : main.online
          ? t('engines.labelOnline', { name: main.name })
          : main.lastSeenAt
            ? t('engines.labelOffline', { name: main.name, ago: formatAgo(main.lastSeenAt, now) })
            : t('engines.labelOfflineUnknown', { name: main.name });
  const compact = badge || phone;
  return (
    <span className={styles.anchor}>
      <button
        ref={button}
        type="button"
        className={compact ? styles.badge : styles.indicator}
        data-state={state}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {compact ? (
          <span className={styles.pill} data-state={state}>
            <Icon name="server" size={16} />
            <span className={styles.dot} data-state={state} />
          </span>
        ) : (
          <>
            <Icon name="server" size={18} />
            <span className={styles.dot} data-state={state} />
            <span className={styles.text}>
              <strong>{text}</strong>
              {state === 'offline' ? ` ${t('engines.offlineSuffix')}` : ''}
            </span>
            <span className={styles.chevron}>
              <Icon name="chevronDown" size={12} />
            </span>
          </>
        )}
      </button>
      {live}
      {open && (
        <EnginePanel id={id} phone={phone} engines={engines} now={now} onClose={close} anchor={button} />
      )}
    </span>
  );
}

function EnginePanel({
  id,
  phone,
  engines,
  now,
  onClose,
  anchor,
}: {
  id: string;
  phone: boolean;
  engines: EngineStatusView[];
  now: Date;
  onClose: () => void;
  anchor: RefObject<HTMLButtonElement | null>;
}) {
  const me = useMe();
  const owner = me.data?.hostOwner === true;
  const counts = useEngines(owner);
  const { key } = useProject();
  const title = useRef<HTMLHeadingElement>(null);
  const [position, setPosition] = useState({ top: 64, right: 16 });
  const main = defaultEngine(engines);
  const heading = engines.length > 1 ? t('engines.titleMany') : t('engines.title');

  useLayoutEffect(() => {
    title.current?.focus();
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 8, right: Math.max(16, window.innerWidth - rect.right) });
  }, [anchor]);
  useEffect(() => {
    if (phone) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) {
        const panel = document.getElementById(id);
        if (!panel?.contains(event.target)) onClose();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [phone, anchor, id, onClose]);

  const settings = (text: string) => (
    <div className={styles.foot}>
      <Link className={styles.link} to={`/p/${key}/settings/engines`} onClick={onClose}>
        {text}
        <Icon name="arrowRight" size={14} />
      </Link>
    </div>
  );
  const body =
    engines.length === 0 ? (
      <>
        <p className={styles.hintFirst}>{t('engines.panelNone')}</p>
        {owner ? (
          settings(t('engines.panelAddEngine'))
        ) : (
          <p className={styles.hint}>{t('engines.panelOwnerAdds')}</p>
        )}
      </>
    ) : (
      <>
        <ul className={styles.list}>
          {defaultFirst(engines).map((engine) => {
            const state = engineState(engine);
            const detail = counts.data?.find((entry) => entry.id === engine.id);
            return (
              <li key={engine.id}>
                <span className={styles.dot} data-state={state} />
                <span className={styles.name}>
                  {engine.name}
                  {engine.isDefault && <span className={styles.chip}>{t('engines.defaultChip')}</span>}
                </span>
                <span className={styles.status} data-needs={state === 'offline'}>
                  {statusText(engine, now)}
                </span>
                {owner && detail && <span className={styles.counts}>{workText(detail)}</span>}
              </li>
            );
          })}
        </ul>
        {!main ? (
          <p className={styles.hint}>
            {t('engines.panelNoDefault')} {t(owner ? 'engines.panelPickOwner' : 'engines.panelPickMember')}
          </p>
        ) : !main.online ? (
          <p className={styles.hint}>{t('engines.panelWaiting')}</p>
        ) : null}
        {owner && settings(t('engines.panelManage'))}
      </>
    );
  if (phone)
    return (
      <Dialog open title={heading} onClose={onClose} size="sm">
        <div id={id}>{body}</div>
      </Dialog>
    );
  return createPortal(
    <div
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      className={styles.panel}
      style={position}
    >
      <h2 ref={title} tabIndex={-1} id={`${id}-title`} className={styles.title}>
        {heading}
      </h2>
      {body}
    </div>,
    document.body,
  );
}
