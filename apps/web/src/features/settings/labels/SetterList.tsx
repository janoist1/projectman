import { useId, useState } from 'react';
import clsx from 'clsx';
import { t } from '../../../i18n/t';
import fields from '../pipeline/StagePanel.module.css';
import styles from './LabelPanel.module.css';

export interface SetterOption {
  value: string;
  name: string;
  /** What the search also matches, e.g. a member's handle. */
  hint?: string;
}

/**
 * A checkbox list that can be searched: the choices of a label's setters (duties or named members). A choice
 * already ticked stays in view while a search hides the others.
 */
export function SetterList({
  legend,
  options,
  value,
  disabled,
  describedBy,
  onChange,
}: {
  legend: string;
  options: readonly SetterOption[];
  value: readonly string[];
  disabled?: boolean;
  describedBy?: string;
  onChange(value: string[]): void;
}) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const needle = query.trim().toLowerCase();
  const shown = options.filter(
    (option) =>
      value.includes(option.value) ||
      !needle ||
      option.name.toLowerCase().includes(needle) ||
      option.hint?.toLowerCase().includes(needle),
  );
  return (
    <fieldset className={styles.setters} disabled={disabled} aria-describedby={describedBy}>
      <legend className={styles.visuallyHidden}>{legend}</legend>
      <input
        id={searchId}
        type="search"
        className={styles.settersSearch}
        value={query}
        placeholder={t('settings.labels.edit.settersSearch')}
        aria-label={t('settings.labels.edit.settersSearchLabel', { what: legend })}
        onChange={(event) => setQuery(event.target.value)}
      />
      {shown.length === 0 ? (
        <p className={fields.hintText}>{t('settings.labels.edit.settersNone', { q: query.trim() })}</p>
      ) : (
        <ul className={styles.settersList}>
          {shown.map((option) => {
            const checked = value.includes(option.value);
            return (
              <li key={option.value}>
                <label className={clsx(fields.radio, checked && fields.picked)}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      onChange(
                        checked ? value.filter((entry) => entry !== option.value) : [...value, option.value],
                      )
                    }
                  />
                  <span>
                    {option.name}
                    {option.hint ? <span className={styles.settersHint}> · {option.hint}</span> : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
