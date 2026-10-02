import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import { useIsMobile } from '../../lib/hooks';
import styles from './Composer.module.css';

interface ComposerProps {
  onSend: (text: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
}

/**
 * Message box for a session: one line that grows as the text does, with a round send button.
 * With a keyboard Enter sends and Shift+Enter adds a new line; on a phone Enter adds a new line
 * and only the button sends.
 */
export function Composer({ onSend, autoFocus = false, disabled = false }: ComposerProps) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const isMobile = useIsMobile();

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isMobile) return;
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
        {t('session.composer.label')}
      </label>
      <div className={styles.row}>
        <textarea
          ref={ref}
          id={id}
          rows={1}
          className={styles.input}
          placeholder={t('session.composer.placeholder')}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby={isMobile ? undefined : `${id}-hint`}
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          iconOnly
          icon="send"
          className={styles.send}
          aria-label={t('common.send')}
          disabled={disabled || !text.trim()}
        />
      </div>
      {isMobile ? null : (
        <span id={`${id}-hint`} className={styles.hint}>
          {t('session.composer.hint')}
        </span>
      )}
    </form>
  );
}
