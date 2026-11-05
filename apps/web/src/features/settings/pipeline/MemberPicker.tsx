import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import clsx from 'clsx';
import { isOnLeave } from '@projectman/shared';
import type { MemberConfig, RoleView } from '@projectman/shared';
import { useRoles } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { Avatar } from '../../../components/Avatar';
import { LeaveChip } from '../../../components/LeaveChip';
import { t } from '../../../i18n/t';
import { roleLabel } from '../../../lib/members';
import { memberLike } from '../../how-we-work/MapContext';
import styles from './MemberPicker.module.css';

/** A member's avatar the way the path shows owners: human round, AI square, dashed while on leave. */
export function MemberAvatar({ member }: { member: MemberConfig }) {
  return (
    <span className={clsx(styles.avatar, isOnLeave(member) && styles.onLeave)}>
      <Avatar member={memberLike(member)} size="sm" variant="initials" ring />
    </span>
  );
}

function matches(member: MemberConfig, query: string, roles: readonly RoleView[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const role = roleLabel(memberLike(member), roles).toLowerCase();
  return (
    member.displayName.toLowerCase().includes(needle) ||
    member.handle.toLowerCase().includes(needle) ||
    role.includes(needle)
  );
}

/**
 * "+ Tag hozzáadása": a search box over the members not chosen yet, as a combobox with a list. Arrow keys
 * move, Enter adds and closes, Escape closes (and only closes: the panel stays) and gives the focus back.
 */
export function MemberPicker({
  candidates,
  disabled = false,
  onAdd,
}: {
  /** The members that can still be added. */
  candidates: readonly MemberConfig[];
  disabled?: boolean;
  onAdd(handle: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const listId = useId();
  // The role catalogue names an AI member's role ("QA", not "qa"), in the list and in the search.
  const roles = useRoles(useProject().key).data?.roles;
  const catalogue = useMemo(() => roles ?? [], [roles]);
  const found = useMemo(
    () => candidates.filter((member) => matches(member, query, catalogue)),
    [candidates, query, catalogue],
  );
  const current = Math.min(active, Math.max(0, found.length - 1));
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    // The list drops down inside a scrolling panel: bring all of it into view.
    popover.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);
  if (candidates.length === 0)
    return <p className={styles.allChosen}>{t('settings.pipeline.edit.memberAllChosen')}</p>;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setQuery('');
    setActive(0);
    if (returnFocus) button.current?.focus();
  };
  const pick = (member: MemberConfig | undefined) => {
    if (!member) return;
    close(true);
    onAdd(member.handle);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (found.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + found.length) % found.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(found[current]);
    } else if (event.key === 'Escape') {
      // The first Escape is the list's; the panel's own handler skips an event that was prevented.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  return (
    <div
      ref={root}
      className={styles.root}
      data-popover-open={open ? '' : undefined}
      onBlur={(event) => {
        if (open && !root.current?.contains(event.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className={styles.add}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        {t('settings.pipeline.edit.addMember')}
      </button>
      {open ? (
        <div ref={popover} className={styles.popover}>
          <input
            ref={search}
            type="search"
            role="combobox"
            className={styles.search}
            aria-label={t('settings.pipeline.edit.memberSearch')}
            placeholder={t('settings.pipeline.edit.memberSearch')}
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={found[current] ? `${listId}-${found[current].handle}` : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          {found.length === 0 ? (
            <p className={styles.none} role="status">
              {t('settings.pipeline.edit.memberNone', { q: query.trim() })}
            </p>
          ) : (
            <ul id={listId} role="listbox" className={styles.list}>
              {found.map((member, index) => (
                <li
                  key={member.handle}
                  id={`${listId}-${member.handle}`}
                  role="option"
                  aria-selected={index === current}
                  className={clsx(styles.option, index === current && styles.current)}
                  // The search keeps the focus while a row is pressed.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(index)}
                  onClick={() => pick(member)}
                >
                  <MemberAvatar member={member} />
                  <span className={styles.name}>{member.displayName}</span>
                  <span className={styles.meta}>
                    {roleLabel(memberLike(member), catalogue)} ·{' '}
                    {t(
                      member.kind === 'ai'
                        ? 'settings.pipeline.edit.memberAi'
                        : 'settings.pipeline.edit.memberHuman',
                    )}
                  </span>
                  <LeaveChip member={member} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
