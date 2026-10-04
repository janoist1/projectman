import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import { useIsMobile, useMediaQuery } from '../../lib/hooks';
import { PauseNote } from '../pause/PauseNote';
import styles from './Composer.module.css';

interface ComposerProps {
  /** A promise keeps the text in the box until it resolves, so a failed send does not lose it. */
  onSend: (text: string) => void | Promise<unknown>;
  autoFocus?: boolean;
  disabled?: boolean;
  /** The box's accessible name and its placeholder; a session's by default. */
  label?: string;
  placeholder?: string;
  /** The team pause's line above the box (PM-220): why a message waits or cannot start the session. */
  pauseNote?: string;
  /** Nothing can be sent yet (a card thread without recipients); the text can still be typed. */
  blocked?: boolean;
}

/** The field stops growing here (about five lines on a phone, so the chat keeps room beside the keyboard). */
const MAX_HEIGHT = 220;
const PHONE_MAX_HEIGHT = 132;

/**
 * Message box for a session: one line that grows as the text does, with a round send button.
 * With a keyboard Enter sends and Shift+Enter adds a new line; on a touch screen Enter adds a new
 * line and only the button sends.
 */
export function Composer({
  onSend,
  autoFocus = false,
  disabled = false,
  label = t('session.composer.label'),
  placeholder = t('session.composer.placeholder'),
  pauseNote,
  blocked = false,
}: ComposerProps) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const isMobile = useIsMobile();
  // The touch screen decides about Enter, not the width: a tablet has no Enter key to send with.
  const touch = useMediaQuery('(pointer: coarse)');

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    // The box is border-box: the borders are not part of scrollHeight.
    const borders = element.offsetHeight - element.clientHeight;
    element.style.height = `${Math.min(element.scrollHeight + borders, isMobile ? PHONE_MAX_HEIGHT : MAX_HEIGHT)}px`;
  }, [text, isMobile]);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled || blocked) return;
    const sent = onSend(value);
    if (sent instanceof Promise) {
      // The caller shows the failure; the text stays so it can be sent again.
      void sent.then(
        () => setText(''),
        () => undefined,
      );
    } else {
      setText('');
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (touch) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className={styles.composer}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      {pauseNote ? <PauseNote id={`${id}-pause`}>{pauseNote}</PauseNote> : null}
      <div className={styles.row}>
        <textarea
          ref={ref}
          id={id}
          rows={1}
          className={styles.input}
          placeholder={placeholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby={
            [pauseNote ? `${id}-pause` : null, touch ? null : `${id}-hint`].filter(Boolean).join(' ') ||
            undefined
          }
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          iconOnly
          icon="send"
          className={styles.send}
          aria-label={t('common.send')}
          disabled={disabled || blocked || !text.trim()}
        />
      </div>
      {touch ? null : (
        <span id={`${id}-hint`} className={styles.hint}>
          {t('session.composer.hint')}
        </span>
      )}
    </form>
  );
}
