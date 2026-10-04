import clsx from 'clsx';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { InboxOption } from '@projectman/shared';
import { Button } from '../../components/Button';
import type { ButtonSize, ButtonVariant } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Fold } from '../../components/Fold';
import { InlineMarkdown, Markdown } from '../../components/Markdown';
import { t } from '../../i18n/t';
import { foldHeight } from '../../lib/foldHeight';
import { optionLabel } from '../../lib/inbox';
import styles from './Question.module.css';

export interface QuestionChoicesProps {
  choices: readonly InboxOption[];
  /** Id of the option the asking member recommends. */
  recommendedOptionId: string | null;
  /** One sentence: why; shown below the recommended option. */
  recommendationReason: string | null;
  size: ButtonSize;
  variantOf: (option: InboxOption) => ButtonVariant;
  disabled?: boolean;
  /** Phone layout: full-width 44px buttons. */
  mobile?: boolean;
  onPick: (option: InboxOption) => void;
}

/**
 * The options of a question that describes them: each one is a button with what happens if it is
 * picked below it, and the recommended one carries a badge and the reason. Questions without
 * either keep the plain row of buttons (see InboxCard).
 */
export function QuestionChoices({
  choices,
  recommendedOptionId,
  recommendationReason,
  size,
  variantOf,
  disabled = false,
  mobile = false,
  onPick,
}: QuestionChoicesProps) {
  const base = useId();
  return (
    <ul className={clsx(styles.choices, mobile && styles.mobile)}>
      {choices.map((option) => {
        const recommended = option.id === recommendedOptionId;
        const badgeId = `${base}-${option.id}-badge`;
        const consequenceId = `${base}-${option.id}-consequence`;
        const reasonId = `${base}-${option.id}-reason`;
        const reason = recommended ? recommendationReason : null;
        // The button is named by its label; the badge, the consequence and the reason describe it.
        const describedBy =
          [recommended ? badgeId : null, option.consequence ? consequenceId : null, reason ? reasonId : null]
            .filter(Boolean)
            .join(' ') || undefined;
        return (
          <li key={option.id} className={clsx(styles.choice, recommended && styles.recommended)}>
            <div className={styles.choiceHead}>
              <Button
                variant={variantOf(option)}
                size={size}
                disabled={disabled}
                aria-describedby={describedBy}
                onClick={() => onPick(option)}
              >
                {optionLabel(option)}
              </Button>
              {recommended ? (
                <Chip id={badgeId} tone="accent" icon="check">
                  {t('inbox.question.recommended')}
                </Chip>
              ) : null}
            </div>
            {option.consequence ? (
              <p id={consequenceId} className={styles.consequence}>
                <InlineMarkdown text={option.consequence} />
              </p>
            ) : null}
            {reason ? (
              <p id={reasonId} className={styles.reason}>
                {t('inbox.question.reasonLabel')} <InlineMarkdown text={reason} />
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** A body taller than this many lines folds. */
const BODY_FOLD_ABOVE_LINES = 10;
/** The line height of the body, as in the style sheet (em). */
const BODY_LINE_HEIGHT = 1.55;

/**
 * The body of a question (what follows its short heading), as markdown. A long one is folded to
 * eight lines with a button to open it; focus moving into the folded part opens it, and the reader
 * of a screen reader always gets the whole text, as the fold is only visual.
 */
export function QuestionBody({
  text,
  mobile = false,
  closed = false,
}: {
  text: string;
  mobile?: boolean;
  /** Shows nothing but the button until it is opened (the heading already says the point of the question). */
  closed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // How tall the folded text is; null while the text is short enough not to fold.
  const [foldedHeight, setFoldedHeight] = useState<number | null>(null);
  const [fade, setFade] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const lineHeight = style.lineHeight.endsWith('px')
        ? parseFloat(style.lineHeight)
        : (parseFloat(style.fontSize) || 14) * BODY_LINE_HEIGHT;
      if (element.scrollHeight <= lineHeight * BODY_FOLD_ABOVE_LINES + 2) {
        setFoldedHeight(null);
        return;
      }
      // The blocks the text is made of: paragraphs, code, and the items of a list one by one.
      const top = element.getBoundingClientRect().top;
      const blocks = [...(element.firstElementChild?.children ?? [])]
        .flatMap((block) =>
          block.tagName === 'UL' || block.tagName === 'OL' ? [...block.children] : [block],
        )
        .map((block) => {
          const box = block.getBoundingClientRect();
          return {
            top: box.top - top,
            bottom: box.bottom - top,
            leadIn: /:\s*$/.test(block.textContent ?? '') || /^H[1-6]$/.test(block.tagName),
          };
        });
      const fold = foldHeight(blocks, lineHeight);
      setFoldedHeight(fold.height);
      setFade(fold.fade);
    };
    measure();
    // The width changes with the window and with a drawer or sidebar opening, not only on resize.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);

  const overflowing = foldedHeight !== null;
  const folded = overflowing && !open;
  const shown = !closed || open;
  return (
    <div className={clsx(styles.body, mobile && styles.mobile)}>
      {shown ? (
        <div
          id={id}
          ref={ref}
          className={clsx(styles.bodyText, folded && styles.clamped, folded && fade && styles.faded)}
          style={folded ? { maxHeight: foldedHeight } : undefined}
          onFocus={() => {
            if (folded) setOpen(true);
          }}
        >
          <Markdown text={text} className={styles.markdown} />
        </div>
      ) : null}
      {overflowing || open || closed ? (
        <button
          type="button"
          className={styles.more}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={shown ? id : undefined}
        >
          {open ? t('inbox.question.less') : t('inbox.question.more')}
        </button>
      ) : null}
    </div>
  );
}

/** The technical background of a question, closed until the reader wants it. */
export function QuestionDetails({ text }: { text: string }) {
  return (
    <Fold summary={t('inbox.question.details')}>
      <Markdown text={text} />
    </Fold>
  );
}
