import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import styles from './Composer.module.css';

interface ComposerProps {
  onSend: (text: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
}

/** Message box for a session: Enter sends, Shift+Enter adds a new line. */
export function Composer({ onSend, autoFocus = false, disabled = false }: ComposerProps) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();

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
      <textarea
        ref={ref}
        id={id}
        rows={2}
        className={styles.input}
        placeholder={t('session.composer.placeholder')}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        aria-describedby={`${id}-hint`}
      />
      <div className={styles.row}>
        <span id={`${id}-hint`} className={styles.hint}>
          {t('session.composer.hint')}
        </span>
        <Button type="submit" variant="primary" size="md" iconRight="send" disabled={disabled || !text.trim()}>
          {t('common.send')}
        </Button>
      </div>
    </form>
  );
}
