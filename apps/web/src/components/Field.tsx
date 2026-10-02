import clsx from 'clsx';
import { forwardRef, useId, useState } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { t } from '../i18n/t';
import { Icon } from './Icon';
import styles from './Field.module.css';

interface FieldFrameProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  hideLabel?: boolean;
  /** Between the label and the control: the editor's formatting buttons. */
  toolbar?: ReactNode;
  className?: string;
  children: ReactNode;
}

function FieldFrame({
  id,
  label,
  hint,
  error,
  optional,
  hideLabel,
  toolbar,
  className,
  children,
}: FieldFrameProps) {
  return (
    <div className={clsx(styles.field, className)}>
      <label htmlFor={id} className={clsx(styles.label, hideLabel && 'visually-hidden')}>
        {label}
        {optional ? <span className={styles.optional}> · {t('common.optional')}</span> : null}
      </label>
      {toolbar}
      {children}
      {error ? (
        <span id={`${id}-error`} className={styles.error} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

interface CommonProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  hideLabel?: boolean;
  fieldClassName?: string;
}

interface TextAreaProps extends CommonProps {
  toolbar?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, CommonProps & InputHTMLAttributes<HTMLInputElement>>(
  function TextField(
    { label, hint, error, optional, hideLabel, fieldClassName, className, id: idProp, ...rest },
    ref,
  ) {
    const generated = useId();
    const id = idProp ?? generated;
    return (
      <FieldFrame
        id={id}
        label={label}
        hint={hint}
        error={error}
        optional={optional}
        hideLabel={hideLabel}
        className={fieldClassName}
      >
        <input
          ref={ref}
          id={id}
          className={clsx(styles.input, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          {...rest}
        />
      </FieldFrame>
    );
  },
);

export const TextAreaField = forwardRef<
  HTMLTextAreaElement,
  TextAreaProps & TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextAreaField(
  { label, hint, error, optional, hideLabel, toolbar, fieldClassName, className, id: idProp, ...rest },
  ref,
) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      hideLabel={hideLabel}
      toolbar={toolbar}
      className={fieldClassName}
    >
      <textarea
        ref={ref}
        id={id}
        className={clsx(styles.input, styles.textarea, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </FieldFrame>
  );
});

export function SelectField({
  label,
  hint,
  error,
  optional,
  hideLabel,
  fieldClassName,
  className,
  id: idProp,
  children,
  ...rest
}: CommonProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      hideLabel={hideLabel}
      className={fieldClassName}
    >
      <span className={styles.selectWrap}>
        <select
          id={id}
          className={clsx(styles.input, styles.select, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          {...rest}
        >
          {children}
        </select>
        <Icon name="chevronDown" size={16} className={styles.selectIcon} />
      </span>
    </FieldFrame>
  );
}

export function PasswordField({
  label,
  hint,
  error,
  fieldClassName,
  className,
  id: idProp,
  ...rest
}: CommonProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const generated = useId();
  const id = idProp ?? generated;
  const [visible, setVisible] = useState(false);
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} className={fieldClassName}>
      <span className={styles.passwordWrap}>
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          className={clsx(styles.input, styles.passwordInput, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          {...rest}
        />
        <button
          type="button"
          className={styles.reveal}
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? t('auth.hidePassword') : t('auth.showPassword')}
          aria-pressed={visible}
        >
          <Icon name={visible ? 'eyeOff' : 'eye'} size={17} />
        </button>
      </span>
    </FieldFrame>
  );
}

interface ChoiceCardProps {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  title: ReactNode;
  description?: string;
  leading?: ReactNode;
}

/** Radio input styled as a selectable card (templates, visibility, handover target). */
export function ChoiceCard({ name, value, checked, onChange, title, description, leading }: ChoiceCardProps) {
  const id = useId();
  return (
    <label htmlFor={id} className={clsx(styles.choice, checked && styles.choiceOn)}>
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className={styles.choiceInput}
      />
      {leading}
      <span className={styles.choiceText}>
        <span className={styles.choiceTitle}>{title}</span>
        {description ? <span className={styles.choiceDescription}>{description}</span> : null}
      </span>
    </label>
  );
}
