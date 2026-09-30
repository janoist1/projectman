import { useId, useRef, useState } from 'react';
import { useCreateTaskComment } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { TextAreaField } from '../../components/Field';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import type { MemberIndex } from '../../lib/members';
import styles from './TaskCommentComposer.module.css';

export function TaskCommentComposer({ taskKey, members }: { taskKey: string; members: MemberIndex }) {
  const { key } = useProject();
  const mutation = useCreateTaskComment(key);
  const [text, setText] = useState('');
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [selected, setSelected] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const options = mention
    ? [...members.values()].filter(
        (member) =>
          member.handle.toLowerCase().includes(mention.query) ||
          member.displayName.toLowerCase().includes(mention.query),
      )
    : [];
  const active = Math.min(selected, Math.max(0, options.length - 1));
  const updateMention = (value: string, caret: number) => {
    const match = /(?:^|[^\p{L}\p{N}_@.+-])@([\p{L}\p{N}-]*)$/u.exec(value.slice(0, caret));
    setMention(
      match ? { start: caret - match[1]!.length - 1, end: caret, query: match[1]!.toLowerCase() } : null,
    );
    setSelected(0);
  };
  const choose = (handle: string) => {
    if (!mention) return;
    const insertion = `@${handle} `;
    // Replace the rest of a token too when editing a mention in the middle of the text.
    const suffix = /^[a-z0-9-]*/i.exec(text.slice(mention.end))![0].length;
    const next = text.slice(0, mention.start) + insertion + text.slice(mention.end + suffix);
    if (next.length > 10000) return;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(mention.start + insertion.length, mention.start + insertion.length);
    });
  };
  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim() || mutation.isPending) return;
        mutation.mutate(
          { taskKey, body: { text: text.trim() } },
          {
            onSuccess: () => {
              setText('');
              setMention(null);
            },
          },
        );
      }}
    >
      <TextAreaField
        ref={textarea}
        label={t('task.comments.label')}
        hint={t('task.comments.hint')}
        rows={3}
        maxLength={10000}
        value={text}
        disabled={mutation.isPending}
        aria-autocomplete="list"
        aria-controls={options.length ? listId : undefined}
        aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
        onChange={(event) => {
          setText(event.target.value);
          updateMention(event.target.value, event.target.selectionStart);
        }}
        onSelect={(event) => {
          if (document.activeElement === event.currentTarget)
            updateMention(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
        onBlur={() => setMention(null)}
        onKeyDown={(event) => {
          if (!mention || event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setMention(null);
          }
          if (!options.length) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const index = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            setSelected(index);
            document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: 'nearest' });
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            choose(options[active]!.handle);
          }
        }}
      />
      {options.length ? (
        <ul id={listId} role="listbox" aria-label={t('task.comments.members')} className={styles.options}>
          {options.map((member, index) => (
            <li key={member.handle} id={`${listId}-${index}`} role="option" aria-selected={active === index}>
              <button
                type="button"
                tabIndex={-1}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(member.handle)}
              >
                {member.displayName} <span>@{member.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {mutation.isError ? <p role="alert">{errorMessage(mutation.error)}</p> : null}
      <Button type="submit" loading={mutation.isPending} disabled={!text.trim()}>
        {t('task.comments.send')}
      </Button>
    </form>
  );
}
