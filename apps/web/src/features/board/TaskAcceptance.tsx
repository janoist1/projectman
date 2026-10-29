import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { acceptanceRefusal, isOpenTask, isTheme } from '@projectman/shared';
import type { AcceptanceChange, AcceptanceItem, AcceptanceRefusal, Task } from '@projectman/shared';
import { useConfig, useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { SelectField, TextAreaField, TextField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { MoreMenu } from '../../components/MoreMenu';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { useCardLink } from './cardSize';
import { useDrawerBase } from './drawerBase';
import { useBoardModel } from './useBoardModel';
import styles from './TaskAcceptance.module.css';

type FormKind = 'done' | 'not_needed' | 'move' | 'edit' | 'reopen' | 'remove';
type Open = { kind: FormKind; itemId: string } | { kind: 'add' } | null;
type Availability = { show: false } | { show: true; reason: string | null };

const TEXT_MAX = 500;
/** A refusal that no situation changes for this viewer: the button is not there at all. */
const NOT_FOR_ME: ReadonlySet<AcceptanceRefusal> = new Set(['card_closed', 'not_marker', 'not_confirmer']);

/** The button of a change: not there, there and active (`reason` null), or there but off with the reason it is. */
function availability(refusal: AcceptanceRefusal | null): Availability {
  if (refusal === null) return { show: true, reason: null };
  if (NOT_FOR_ME.has(refusal)) return { show: false };
  return { show: true, reason: t(`errors.acceptanceRefusal.${refusal}`) };
}

interface FormText {
  label?: string;
  placeholder?: string;
  hint?: string;
  submit: string;
  required: boolean;
}

const formText = (kind: FormKind): FormText => FORM_TEXT()[kind];

const FORM_TEXT = (): Record<FormKind, FormText> => ({
  done: {
    label: t('task.acceptance.form.doneLabel'),
    placeholder: t('task.acceptance.form.donePlaceholder'),
    hint: t('task.acceptance.form.doneHint'),
    submit: t('task.acceptance.form.doneSubmit'),
    required: true,
  },
  not_needed: {
    label: t('task.acceptance.form.notNeededLabel'),
    submit: t('task.acceptance.form.notNeededSubmit'),
    required: true,
  },
  move: {
    label: t('task.acceptance.form.moveLabel'),
    hint: t('task.acceptance.form.moveHint'),
    submit: t('task.acceptance.form.moveSubmit'),
    required: true,
  },
  edit: {
    label: t('task.acceptance.form.editLabel'),
    submit: t('task.acceptance.form.editSubmit'),
    required: true,
  },
  reopen: {
    label: t('task.acceptance.form.reopenLabel'),
    submit: t('task.acceptance.form.reopenSubmit'),
    required: false,
  },
  remove: { submit: t('task.acceptance.form.removeSubmit'), required: false },
});

function changeOf(kind: FormKind, itemId: string, value: string): AcceptanceChange {
  const text = value.trim();
  switch (kind) {
    case 'done':
      return { op: 'done', itemId, evidence: text };
    case 'not_needed':
      return { op: 'not_needed', itemId, reason: text };
    case 'move':
      return { op: 'move', itemId, taskKey: text };
    case 'edit':
      return { op: 'edit', itemId, text };
    case 'reopen':
      return text ? { op: 'reopen', itemId, note: text } : { op: 'reopen', itemId };
    case 'remove':
      return { op: 'remove', itemId };
  }
}

/** The inline form of one change on a row: one field, the button that sends it, Esc closes. */
function ItemForm({
  kind,
  item,
  candidates,
  saving,
  error,
  onSubmit,
  onCancel,
}: {
  kind: FormKind;
  item: AcceptanceItem;
  candidates: readonly Task[];
  saving: boolean;
  error: string | null;
  onSubmit: (change: AcceptanceChange) => void;
  onCancel: () => void;
}) {
  const text = formText(kind);
  const [value, setValue] = useState(kind === 'edit' ? item.text : '');
  const form = useRef<HTMLFormElement>(null);
  const ready = !text.required || value.trim() !== '';

  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      form.current?.querySelector<HTMLElement>('textarea, select, input, button')?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !saving) onSubmit(changeOf(kind, item.id, value));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onCancel();
  };

  return (
    <form ref={form} className={styles.form} onSubmit={submit} onKeyDown={onKeyDown} aria-busy={saving}>
      {kind === 'remove' ? (
        <p className={styles.question}>{t('task.acceptance.form.removeQuestion')}</p>
      ) : kind === 'move' ? (
        <SelectField
          label={text.label ?? ''}
          hint={text.hint}
          error={error}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">{t('task.acceptance.form.movePlaceholder')}</option>
          {candidates.map((card) => (
            <option key={card.key} value={card.key}>
              {card.key} · {card.title}
            </option>
          ))}
        </SelectField>
      ) : (
        <TextAreaField
          label={text.label ?? ''}
          hint={text.hint}
          error={error}
          placeholder={text.placeholder}
          value={value}
          maxLength={kind === 'edit' ? TEXT_MAX : undefined}
          rows={kind === 'edit' ? 2 : 3}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      {kind === 'remove' && error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {t('task.acceptance.form.cancel')}
        </Button>
        <Button
          type="submit"
          variant={kind === 'remove' ? 'danger' : 'primary'}
          size="sm"
          loading={saving}
          disabled={!ready}
        >
          {text.submit}
        </Button>
      </div>
    </form>
  );
}

/** The add row: an input that keeps itself open, so a list is typed in one go. */
function AddForm({
  saving,
  error,
  onSubmit,
  onClose,
}: {
  saving: boolean;
  error: string | null;
  onSubmit: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || saving) return;
    if (await onSubmit(text)) {
      setValue('');
      input.current?.focus();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  };

  return (
    <form className={styles.addForm} onSubmit={submit} onKeyDown={onKeyDown} aria-busy={saving}>
      <TextField
        ref={input}
        label={t('task.acceptance.add.label')}
        hideLabel
        placeholder={t('task.acceptance.add.placeholder')}
        maxLength={TEXT_MAX}
        value={value}
        error={error}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t('task.acceptance.add.close')}
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={saving} disabled={value.trim() === ''}>
          {t('task.acceptance.add.submit')}
        </Button>
      </div>
    </form>
  );
}

function ItemMeta({
  item,
  members,
  myHandle,
}: {
  item: AcceptanceItem;
  members: MemberIndex;
  myHandle: string | null;
}) {
  const cardLink = useCardLink();
  const drawerBase = useDrawerBase();
  const link = (taskKey: string) => (
    <Link to={cardLink(drawerBase.card(taskKey))} className={styles.link}>
      {taskKey}
    </Link>
  );
  return (
    <>
      {item.state === 'done' && item.evidence ? (
        <p className={styles.detail}>{t('task.acceptance.evidence', { text: item.evidence })}</p>
      ) : null}
      {item.state === 'not_needed' && item.reason ? (
        <p className={styles.detail}>{t('task.acceptance.notNeeded', { text: item.reason })}</p>
      ) : null}
      {item.state === 'moved' && item.movedTo ? (
        <p className={styles.detail}>
          {t('task.acceptance.movedTo')} {link(item.movedTo)}
        </p>
      ) : null}
      {item.origin ? (
        <p className={styles.detail}>
          {t('task.acceptance.origin')} {link(item.origin.taskKey)}
        </p>
      ) : null}
      {item.markedBy && item.markedAt ? (
        <p className={styles.meta}>
          {t('task.acceptance.marked', {
            name: nameOf(item.markedBy, members, myHandle),
            when: formatAgo(item.markedAt),
          })}
        </p>
      ) : null}
      {item.confirmedBy && item.confirmedAt ? (
        <p className={styles.meta}>
          {t('task.acceptance.confirmed', {
            name: nameOf(item.confirmedBy, members, myHandle),
            when: formatAgo(item.confirmedAt),
          })}
        </p>
      ) : item.state === 'done' || item.state === 'not_needed' ? (
        <p className={styles.meta}>{t('task.acceptance.unconfirmed')}</p>
      ) : null}
    </>
  );
}

/**
 * The acceptance items of a card (PM-1137): the conditions that make it done, each marked with its evidence and
 * confirmed by somebody else. What a button may do is asked of the shared `acceptanceRefusal`, the same rule the
 * server applies; an error from the server is shown with its reason.
 */
export function TaskAcceptance({
  task,
  items,
  loading,
}: {
  task: Task;
  items: readonly AcceptanceItem[] | undefined;
  loading: boolean;
}) {
  const { key, myHandle, can } = useProject();
  const { board, members } = useBoardModel();
  const config = useConfig(key, can.readConfig).data?.config;
  const update = useUpdateTask(key);
  const [open, setOpen] = useState<Open>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<string | null>(null);

  useEffect(() => {
    if (open !== null || restoreFocus.current === null) return;
    const target = restoreFocus.current;
    restoreFocus.current = null;
    const row = target === 'add' ? null : list.current?.querySelector<HTMLElement>(`[data-item="${target}"]`);
    (row?.querySelector<HTMLElement>('button') ?? addButton.current)?.focus();
  }, [open]);

  if (isTheme(task) || (loading && !can.createTasks)) return null;
  if (loading) {
    return (
      <section className={styles.section} aria-labelledby={`acceptance-title-${task.key}`}>
        <h3 id={`acceptance-title-${task.key}`} className={styles.title}>
          {t('task.acceptance.title')}
        </h3>
        <div role="status" aria-label={t('task.acceptance.loading')} className={styles.skeletons}>
          <span className={styles.skeleton} />
          <span className={styles.skeleton} />
        </div>
      </section>
    );
  }
  if (!items) return null;

  const actor = { kind: 'human', handle: myHandle } as const;
  const acting = Boolean(config && can.createTasks && myHandle);
  const candidates = (board.data?.tasks ?? []).filter(
    (card) => card.key !== task.key && isOpenTask(card) && !isTheme(card),
  );
  const refusalOf = (change: AcceptanceChange, item?: AcceptanceItem): Availability =>
    config && acting
      ? availability(
          acceptanceRefusal({
            config,
            task,
            item,
            count: items.length,
            change,
            actor,
            target:
              change.op === 'move' ? (candidates.find((card) => card.key === change.taskKey) ?? null) : null,
          }),
        )
      : { show: false };

  const addAvailability = refusalOf({ op: 'add', text: '-' });
  if (items.length === 0 && !addAvailability.show) return null;

  const pending = update.isPending ? update.variables.body.acceptance?.[0] : undefined;
  const busyItem = pending && 'itemId' in pending ? pending.itemId : null;
  const settled = items.filter((item) => item.state !== 'open');
  const confirmed = settled.filter((item) => item.confirmedBy !== null);

  const send = async (change: AcceptanceChange, scope: string): Promise<boolean> => {
    setError(null);
    try {
      await update.mutateAsync({ taskKey: task.key, body: { acceptance: [change] } });
      return true;
    } catch (caught) {
      setError({ scope, message: errorMessage(caught) });
      return false;
    }
  };
  const closeForm = (focusOn: string) => {
    restoreFocus.current = focusOn;
    setOpen(null);
    setError(null);
  };
  const submitForm = async (itemId: string, change: AcceptanceChange) => {
    if (await send(change, itemId)) closeForm(itemId);
  };

  const menuEntries = (item: AcceptanceItem): { kind: FormKind; avail: Availability }[] => {
    const kinds: FormKind[] =
      item.state === 'open'
        ? ['not_needed', 'move', 'edit', 'remove']
        : item.state === 'moved'
          ? ['remove']
          : ['reopen', 'remove'];
    return kinds
      .map((kind) => {
        const change: AcceptanceChange =
          kind === 'move'
            ? { op: 'move', itemId: item.id, taskKey: candidates[0]?.key ?? task.key }
            : changeOf(kind, item.id, 'x');
        return {
          kind,
          avail:
            kind === 'move' && candidates.length === 0 ? ({ show: false } as const) : refusalOf(change, item),
        };
      })
      .filter((entry) => entry.avail.show);
  };

  return (
    <section className={styles.section} aria-labelledby={`acceptance-title-${task.key}`}>
      <div className={styles.head}>
        <h3 id={`acceptance-title-${task.key}`} className={styles.title}>
          {t('task.acceptance.title')}
        </h3>
        {items.length > 0 ? (
          <span className={styles.progress}>
            {t('task.acceptance.progress', {
              done: settled.length,
              total: items.length,
              confirmed: confirmed.length,
            })}
          </span>
        ) : null}
      </div>

      {items.length === 0 ? <p className={styles.empty}>{t('task.acceptance.empty')}</p> : null}

      {items.length > 0 ? (
        <ul ref={list} className={styles.list} aria-label={t('task.acceptance.listLabel')}>
          {items.map((item) => {
            const busy = busyItem === item.id;
            const primary =
              item.state === 'open'
                ? {
                    op: 'done' as const,
                    avail: refusalOf({ op: 'done', itemId: item.id, evidence: '-' }, item),
                  }
                : item.state !== 'moved' && item.confirmedBy === null
                  ? { op: 'confirm' as const, avail: refusalOf({ op: 'confirm', itemId: item.id }, item) }
                  : null;
            const entries = menuEntries(item);
            const form = open && open.kind !== 'add' && open.itemId === item.id ? open.kind : null;
            const rowError = error?.scope === item.id ? error.message : null;
            return (
              <li key={item.id} className={styles.item} data-item={item.id} aria-busy={busy}>
                <div className={styles.row}>
                  <span
                    className={styles.circle}
                    data-state={item.state}
                    data-confirmed={item.confirmedBy !== null || undefined}
                    role="img"
                    aria-label={t(`task.acceptance.state.${item.state}`)}
                  >
                    {item.state === 'done' ? <Icon name="check" size={13} /> : null}
                    {item.state === 'not_needed' ? <Icon name="minus" size={13} /> : null}
                    {item.state === 'moved' ? <Icon name="arrowRight" size={13} /> : null}
                  </span>
                  <div className={styles.body}>
                    <p className={styles.text} data-state={item.state}>
                      {item.text}
                    </p>
                    <ItemMeta item={item} members={members} myHandle={myHandle} />
                  </div>
                  {acting && (primary?.avail.show || entries.length > 0) ? (
                    <div className={styles.actions}>
                      {primary?.avail.show ? (
                        <Button
                          variant={primary.op === 'confirm' ? 'primary' : 'secondary'}
                          size="sm"
                          loading={busy && pending?.op === 'confirm'}
                          disabled={primary.avail.reason !== null || busy}
                          aria-describedby={primary.avail.reason ? `acceptance-why-${item.id}` : undefined}
                          onClick={() =>
                            primary.op === 'confirm'
                              ? void send({ op: 'confirm', itemId: item.id }, item.id)
                              : setOpen({ kind: 'done', itemId: item.id })
                          }
                        >
                          {primary.op === 'confirm'
                            ? t('task.acceptance.actions.confirm')
                            : t('task.acceptance.actions.done')}
                        </Button>
                      ) : null}
                      {entries.length > 0 ? (
                        <MoreMenu label={t('task.acceptance.more')}>
                          {(close) =>
                            entries.map(({ kind, avail }) => (
                              <div key={kind} className={styles.menuEntry}>
                                <Button
                                  variant={kind === 'remove' ? 'danger' : 'ghost'}
                                  size="sm"
                                  disabled={avail.show && avail.reason !== null}
                                  onClick={() => {
                                    close();
                                    setError(null);
                                    setOpen({ kind, itemId: item.id });
                                  }}
                                >
                                  {t(`task.acceptance.actions.${kind === 'not_needed' ? 'notNeeded' : kind}`)}
                                </Button>
                                {avail.show && avail.reason ? (
                                  <span className={styles.why}>{avail.reason}</span>
                                ) : null}
                              </div>
                            ))
                          }
                        </MoreMenu>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {primary?.avail.show && primary.avail.reason ? (
                  <p id={`acceptance-why-${item.id}`} className={styles.whyBelow}>
                    {primary.avail.reason}
                  </p>
                ) : null}
                {form ? (
                  <ItemForm
                    kind={form}
                    item={item}
                    candidates={candidates}
                    saving={busy}
                    error={rowError}
                    onSubmit={(change) => void submitForm(item.id, change)}
                    onCancel={() => closeForm(item.id)}
                  />
                ) : rowError ? (
                  <p role="alert" className={`${styles.error} ${styles.errorBelow}`}>
                    {rowError}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {addAvailability.show ? (
        open?.kind === 'add' ? (
          <AddForm
            saving={update.isPending && pending?.op === 'add'}
            error={error?.scope === 'add' ? error.message : null}
            onSubmit={(text) => send({ op: 'add', text }, 'add')}
            onClose={() => closeForm('add')}
          />
        ) : (
          <div className={styles.addRow}>
            <Button
              ref={addButton}
              variant="ghost"
              size="sm"
              disabled={addAvailability.reason !== null}
              aria-describedby={addAvailability.reason ? `acceptance-why-add-${task.key}` : undefined}
              onClick={() => {
                setError(null);
                setOpen({ kind: 'add' });
              }}
            >
              {t('task.acceptance.add.open')}
            </Button>
            {addAvailability.reason ? (
              <span id={`acceptance-why-add-${task.key}`} className={styles.why}>
                {addAvailability.reason}
              </span>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}
