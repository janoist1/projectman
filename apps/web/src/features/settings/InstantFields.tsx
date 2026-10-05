import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import shared from './settings.module.css';

/** A checkbox with its explanation below: it changes (and saves) the moment it is clicked. */
export function ToggleField({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const helpId = useId();
  return (
    <div className={shared.toggle}>
      <label className={shared.check}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={help ? helpId : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
      {help ? (
        <p id={helpId} className={shared.help}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A whole number that is saved when the field is left (or Enter is pressed), not on every
 * keystroke. A number outside its range is not saved; the field says so and keeps the text.
 * With `optional`, emptying the field removes the value.
 */
export function InstantNumber({
  label,
  hint,
  value,
  min,
  max,
  step,
  placeholder,
  optional,
  disabled,
  onCommit,
}: {
  label: string;
  hint?: ReactNode;
  value: number | undefined;
  min: number;
  max: number;
  step?: number;
  placeholder?: string;
  optional?: boolean;
  disabled?: boolean;
  onCommit: (value: number | undefined) => void;
}) {
  const shownValue = value === undefined ? '' : String(value);
  const [text, setText] = useState(shownValue);
  const [synced, setSynced] = useState(shownValue);
  const [invalid, setInvalid] = useState(false);
  // The saved value changed under the field (a refresh, a refusal): show it.
  if (synced !== shownValue) {
    setSynced(shownValue);
    setText(shownValue);
    setInvalid(false);
  }
  const commit = () => {
    if (text.trim() === '') {
      if (optional) {
        setInvalid(false);
        if (value !== undefined) onCommit(undefined);
      } else setInvalid(true);
      return;
    }
    const number = Number(text);
    if (!Number.isInteger(number) || number < min || number > max) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (number !== value) onCommit(number);
  };
  return (
    <TextField
      type="number"
      label={label}
      hint={hint}
      error={invalid ? t('settings.limits.range', { min, max }) : null}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}

/** A slider that saves when it is released, not while it is dragged. */
export function InstantRange({
  label,
  hint,
  value,
  min,
  max,
  format,
  disabled,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  format: (value: number) => string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [local, setLocal] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setLocal(value);
  }
  const id = useId();
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <div className={shared.toggle}>
      <label htmlFor={id} className={shared.fieldLabel}>
        {label}
      </label>
      <div className={shared.range}>
        <input
          id={id}
          type="range"
          aria-describedby={hint ? `${id}-hint` : undefined}
          min={min}
          max={max}
          value={local}
          disabled={disabled}
          onChange={(event) => setLocal(Number(event.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <output htmlFor={id}>{format(local)}</output>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className={shared.help}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
