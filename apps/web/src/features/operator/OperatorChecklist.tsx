import clsx from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import type { ChecklistItem, SetChecklistItemStateRequest } from '@projectman/shared';
import { useChecklist, useSetChecklistItemState } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ErrorState } from '../../components/States';
import { t } from '../../i18n/t';
import { readStorage, writeStorage } from '../../lib/hooks';
import styles from './OperatorChecklist.module.css';

export function OperatorChecklist() {
  const { key, me, operatorChecklistRequest } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const enabled = access === 'owner' || access === 'admin';
  const query = useChecklist(key, enabled);
  const checklist = query.data?.checklist;
  const storageKey = `operatorChecklistOpen:${key}`;
  const [choice, setChoice] = useState<boolean | null>(() => {
    const stored = readStorage(storageKey);
    return stored === null ? null : stored === 'true';
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const head = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [intro, setIntro] = useState(false);
  const appliedRequest = useRef<number | null>(null);
  useEffect(() => {
    if (checklist) setChoice((previous) => previous ?? !checklist.progress.complete);
  }, [checklist]);
  useEffect(() => {
    if (
      !operatorChecklistRequest ||
      !checklist?.items.length ||
      appliedRequest.current === operatorChecklistRequest.id
    )
      return;
    appliedRequest.current = operatorChecklistRequest.id;
    setChoice(true);
    writeStorage(storageKey, 'true');
    setIntro(operatorChecklistRequest.intro);
    if (operatorChecklistRequest.focus) head.current?.focus();
  }, [operatorChecklistRequest, checklist, storageKey]);

  if (!enabled) return null;
  if (query.isPending)
    return (
      <div className={styles.loading} role="status" aria-label={t('app.loading')}>
        <span />
      </div>
    );
  if (query.isError)
    return (
      <div className={styles.loadError}>
        <ErrorState
          compact
          error={query.error}
          message={t('operator.checklist.loadFailed')}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  if (!checklist?.items.length) return null;
  const { settled, total, complete } = checklist.progress;
  const open = choice ?? !complete;
  const next = checklist.items.find((item) => item.state === 'open');
  return (
    <section className={clsx(styles.checklist, open && styles.expanded, complete && styles.complete)}>
      <button
        ref={head}
        className={styles.head}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setChoice(!open);
          writeStorage(storageKey, String(!open));
        }}
      >
        <span className={styles.summary}>
          <span>
            <strong>{t('operator.checklist.title')}</strong>{' '}
            <span className={styles.count}>
              {settled}/{total}
            </span>
            <span className={styles.bar} aria-hidden="true">
              <span style={{ width: `${(settled / total) * 100}%` }} />
            </span>
          </span>
          <span className={styles.next}>
            {complete
              ? t('operator.checklist.complete')
              : next
                ? t('operator.checklist.next', { title: next.title })
                : ''}
          </span>
        </span>
        <span className={clsx(styles.chevron, open && styles.rotated)}>
          <Icon name="chevronDown" size={16} />
        </span>
      </button>
      <div id={listId} hidden={!open} className={styles.listBody}>
        {intro ? <p className={styles.intro}>{t('operator.checklist.intro')}</p> : null}
        <ul className={styles.list}>
          {checklist.items.map((item) => (
            <ChecklistRow
              key={item.id}
              item={item}
              canEdit={query.data.canEdit}
              open={expanded === item.id}
              onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function ChecklistRow({
  item,
  canEdit,
  open,
  onToggle,
}: {
  item: ChecklistItem;
  canEdit: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  const row = useRef<HTMLButtonElement>(null);
  const previous = useRef(item.updatedAt);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (previous.current === item.updatedAt) return;
    previous.current = item.updatedAt;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(timer);
  }, [item.updatedAt]);
  return (
    <li className={clsx(styles.item, flash && styles.flash)}>
      <button ref={row} className={styles.row} aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span
          role="img"
          aria-label={t(`operator.checklist.state.${item.state}`)}
          className={clsx(styles.state, styles[item.state])}
        >
          {item.state === 'done' ? <Icon name="check" size={13} /> : item.state === 'not_needed' ? '−' : null}
        </span>
        <span className={styles.itemText}>
          <span className={clsx(item.state !== 'open' && styles.settled)}>{item.title}</span>
          {item.state === 'not_needed' ? (
            <small>{t('operator.checklist.reason', { reason: item.reason ?? '' })}</small>
          ) : null}
          {item.state === 'open' && item.condition ? (
            <small className={styles.condition}>
              <span className={clsx(styles.dot, item.conditionHolds && styles.holds)} />
              {t(
                item.conditionHolds
                  ? 'operator.checklist.condition.holds'
                  : 'operator.checklist.condition.unmet',
                { condition: t(`operator.checklist.condition.${item.condition}`) },
              )}
            </small>
          ) : null}
          {item.reopened ? (
            <small className={styles.reopened}>
              {t(
                item.reopened === 'condition'
                  ? 'operator.checklist.reopened.condition'
                  : canEdit
                    ? 'operator.checklist.reopened.ownerSelf'
                    : 'operator.checklist.reopened.owner',
              )}
            </small>
          ) : null}
        </span>
      </button>
      {open ? (
        <div id={id} className={styles.detail}>
          {item.hint ? <p>{item.hint}</p> : null}
          {canEdit ? (
            <ChecklistActions item={item} onSaved={() => row.current?.focus()} />
          ) : (
            <small>{t('operator.checklist.ownerOnly')}</small>
          )}
        </div>
      ) : null}
    </li>
  );
}

function ChecklistActions({ item, onSaved }: { item: ChecklistItem; onSaved: () => void }) {
  const { key } = useProject();
  const mutation = useSetChecklistItemState(key);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const reasonId = useId();
  useEffect(() => {
    if (editing) textarea.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [editing]);
  useEffect(() => {
    if (editing || mutation.isError) actions.current?.scrollIntoView({ block: 'nearest' });
  }, [editing, mutation.isError]);
  const cancel = () => {
    restoreFocus.current = true;
    setEditing(false);
    setReason('');
    mutation.reset();
  };
  const save = (body: SetChecklistItemStateRequest) => {
    if (mutation.isPending) return;
    mutation.mutate(
      { itemId: item.id, body },
      {
        onSuccess: () => {
          setEditing(false);
          setReason('');
          onSaved();
        },
      },
    );
  };
  return (
    <div ref={actions} className={styles.actionContent}>
      {item.state !== 'open' ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={mutation.isPending}
          onClick={() => save({ state: 'open' })}
        >
          {t('operator.checklist.reopen')}
        </Button>
      ) : editing ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim()) save({ state: 'not_needed', reason: reason.trim() });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              if (!mutation.isPending) cancel();
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              if (reason.trim()) save({ state: 'not_needed', reason: reason.trim() });
            }
          }}
        >
          <label htmlFor={reasonId}>{t('operator.checklist.notNeeded.label')}</label>
          <textarea
            id={reasonId}
            ref={textarea}
            maxLength={500}
            value={reason}
            disabled={mutation.isPending}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('operator.checklist.notNeeded.placeholder')}
          />
          <small className={styles.counter}>{reason.length}/500</small>
          <div className={styles.actions}>
            <Button type="submit" variant="primary" size="sm" disabled={!reason.trim() || mutation.isPending}>
              {t('operator.checklist.notNeeded.save')}
            </Button>
            <Button variant="ghost" size="sm" disabled={mutation.isPending} onClick={cancel}>
              {t('operator.checklist.notNeeded.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          ref={trigger}
          variant="secondary"
          size="sm"
          onClick={() => {
            mutation.reset();
            setEditing(true);
          }}
        >
          {t('operator.checklist.notNeeded.open')}
        </Button>
      )}
      {mutation.isError ? (
        <p role="alert" className={styles.error}>
          {t('operator.checklist.saveFailed')}
        </p>
      ) : null}
    </div>
  );
}
