import type { FeedbackMarkView, FeedbackPerson } from '@projectman/shared';
import { t } from '../i18n';
import { MARKER_COLORS, colorIndexOf, monogramOf } from '../palette';
import { statusOf, statusText } from '../status';

/** The marker colour of a person as a CSS variable reference, set on an element as `--pc`. */
export const colorVar = (person: Pick<FeedbackPerson, 'color'> | null): string =>
  `var(--mk-${colorIndexOf(person) + 1})`;

export const paletteVariables = (): string =>
  MARKER_COLORS.map((color, index) => `--mk-${index + 1}:${color}`).join(';');

/** A human is a round avatar in their colour, an AI member a dark square. Text only: never markup. */
export function Avatar({ person }: { person: FeedbackPerson }) {
  return (
    <span
      class={`av${person.kind === 'ai' ? ' ai' : ''}`}
      style={{ '--pc': colorVar(person) }}
      aria-hidden="true"
    >
      {monogramOf(person)}
    </span>
  );
}

export function personName(person: FeedbackPerson): string {
  return person.kind === 'ai' ? t('thread.ai', { name: person.name }) : person.name;
}

export function StatusLabel({ mark }: { mark: Pick<FeedbackMarkView, 'status' | 'outcome' | 'working'> }) {
  const status = statusOf(mark);
  return <span class={`status st-${status}`}>{t(statusText(status))}</span>;
}
