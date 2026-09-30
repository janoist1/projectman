import { useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { TextAreaField } from './Field';
import { Markdown } from './Markdown';
import styles from './DescriptionEditor.module.css';

type Action = 'bold' | 'italic' | 'heading' | 'bullet' | 'numbered' | 'taskList' | 'link' | 'code';
const actions: Action[] = ['bold', 'italic', 'heading', 'bullet', 'numbered', 'taskList', 'link', 'code'];

/** Selection replacement shared by toolbar and keyboard commands. */
export function formatSelection(value: string, start: number, end: number, action: Action) {
  const selected = value.slice(start, end);
  if (['heading', 'bullet', 'numbered', 'taskList'].includes(action)) {
    start = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
    end = lineEnd < 0 ? value.length : lineEnd;
    const text = value
      .slice(start, end)
      .split('\n')
      .map((line, index) => {
        const prefix =
          action === 'heading'
            ? '## '
            : action === 'bullet'
              ? '- '
              : action === 'taskList'
                ? '- [ ] '
                : `${index + 1}. `;
        return prefix + line;
      })
      .join('\n');
    return { start, end, text, selectionStart: start, selectionEnd: start + text.length };
  }
  const marker = action === 'bold' ? '**' : action === 'italic' ? '*' : action === 'code' ? '`' : '[';
  const content = selected || t('editor.placeholder');
  const suffix = action === 'link' ? '](https://example.com)' : marker;
  return {
    start,
    end,
    text: marker + content + suffix,
    selectionStart: start + marker.length,
    selectionEnd: start + marker.length + content.length,
  };
}

export function DescriptionEditor({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const history = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  const nativeEdits = useRef(false);
  const change = (next: string) => {
    if (next === value) return;
    history.current.past.push(value);
    history.current.future = [];
    onChange(next);
  };
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    const grow = () => {
      node.style.height = 'auto';
      node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
    };
    grow();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(grow);
    observer?.observe(node.parentElement!);
    window.addEventListener('resize', grow);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', grow);
    };
  }, [value, preview]);

  const apply = (action: Action) => {
    const node = input.current;
    if (!node || disabled) return;
    const edit = formatSelection(value, node.selectionStart, node.selectionEnd, action);
    node.focus();
    node.setSelectionRange(edit.start, edit.end);
    // Native insertion retains the browser's undo stack where supported.
    const inserted =
      typeof document.execCommand === 'function' && document.execCommand('insertText', false, edit.text);
    nativeEdits.current = Boolean(inserted);
    if (!inserted) node.setRangeText(edit.text, edit.start, edit.end, 'end');
    change(node.value);
    node.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  };

  return (
    <div className={styles.editor}>
      <div className={styles.switch}>
        <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
          {t('editor.write')}
        </button>
        <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
          {t('editor.preview')}
        </button>
      </div>
      <div hidden={preview}>
        <div className={styles.toolbar} role="toolbar" aria-label={t('editor.toolbar')}>
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => apply(action)}
            >
              {t(`editor.${action}`)}
            </button>
          ))}
        </div>
        <TextAreaField
          ref={input}
          label={label}
          value={value}
          disabled={disabled}
          rows={8}
          className={styles.input}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            if (!(event.metaKey || event.ctrlKey) || event.altKey || disabled) return;
            const key = event.key.toLowerCase();
            const action = key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'k' ? 'link' : null;
            if (action) {
              event.preventDefault();
              apply(action);
            } else if (!nativeEdits.current && (key === 'z' || key === 'y')) {
              const redo = key === 'y' || event.shiftKey;
              const source = redo ? history.current.future : history.current.past;
              const next = source.pop();
              if (next !== undefined) {
                event.preventDefault();
                (redo ? history.current.past : history.current.future).push(value);
                onChange(next);
              }
            }
          }}
        />
      </div>
      {preview ? (
        <div className={styles.preview} role="region" aria-label={t('editor.preview')}>
          <Markdown text={value} />
        </div>
      ) : null}
    </div>
  );
}
