import clsx from 'clsx';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import type { LinkProps } from 'react-router';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'muted' | 'danger' | 'dangerSolid' | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

interface StyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  iconOnly?: boolean;
  className?: string;
}

function buttonClass({
  variant = 'secondary',
  size = 'lg',
  fullWidth,
  iconOnly,
  className,
}: StyleOptions): string {
  return clsx(
    styles.button,
    styles[variant],
    styles[size],
    fullWidth && styles.full,
    iconOnly && styles.iconOnly,
    className,
  );
}

const iconPx: Record<ButtonSize, number> = { sm: 15, md: 16, lg: 17, xl: 18 };

interface ContentProps {
  icon?: IconName;
  iconRight?: IconName;
  size?: ButtonSize;
  loading?: boolean;
  children?: ReactNode;
}

function Content({ icon, iconRight, size = 'lg', loading, children }: ContentProps) {
  return (
    <>
      {loading ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} size={iconPx[size]} strokeWidth={2.1} />
      ) : null}
      {children !== undefined && children !== null ? <span className={styles.label}>{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={iconPx[size]} strokeWidth={2.1} /> : null}
    </>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, StyleOptions {
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    size = 'lg',
    fullWidth,
    iconOnly,
    className,
    icon,
    iconRight,
    loading,
    children,
    type = 'button',
    disabled,
    onClick,
    ...rest
  },
  ref,
) {
  // `aria-disabled` keeps the button focusable (a touch screen and the keyboard still reach its
  // explanation) but does nothing on a click.
  const blocked = rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant, size, fullWidth, iconOnly, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={blocked ? (event) => event.preventDefault() : onClick}
      {...rest}
    >
      <Content icon={icon} iconRight={iconRight} size={size} loading={loading}>
        {children}
      </Content>
    </button>
  );
});

export interface ButtonLinkProps extends LinkProps, StyleOptions {
  icon?: IconName;
  iconRight?: IconName;
}

export function ButtonLink({
  variant,
  size = 'lg',
  fullWidth,
  iconOnly,
  className,
  icon,
  iconRight,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link className={buttonClass({ variant, size, fullWidth, iconOnly, className })} {...rest}>
      <Content icon={icon} iconRight={iconRight} size={size}>
        {children as ReactNode}
      </Content>
    </Link>
  );
}
