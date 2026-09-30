import clsx from 'clsx';
import { useId } from 'react';
import type { InboxOption } from '@projectman/shared';
import { Button } from '../../components/Button';
import type { ButtonSize, ButtonVariant } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { t } from '../../i18n/t';
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
                {option.consequence}
              </p>
            ) : null}
            {reason ? (
              <p id={reasonId} className={styles.reason}>
                {t('inbox.question.reason', { reason })}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The technical background of a question, closed until the reader wants it. */
export function QuestionDetails({ text }: { text: string }) {
  return (
    <details className={styles.fold}>
      <summary className={styles.foldSummary}>
        <Icon name="chevronRight" size={14} strokeWidth={2.4} className={styles.foldChevron} />
        {t('inbox.question.details')}
      </summary>
      <Markdown text={text} className={styles.foldBody} />
    </details>
  );
}
