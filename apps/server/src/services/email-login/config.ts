import { isSesRegion } from './ses-mailer';
import type { SesEmailCodeMailerOptions } from './ses-mailer';

const EMAIL_LOGIN_NOT_CONFIGURED = 'email_login_not_configured';

/** Every variable of the e-mail login (PM-669); none of them reaches a child process. */
export const EMAIL_LOGIN_ENV_NAMES = [
  'PROJECTMAN_EMAIL_LOGIN_ENABLED',
  'PROJECTMAN_SES_REGION',
  'PROJECTMAN_SES_FROM',
  'PROJECTMAN_SES_ACCESS_KEY_ID',
  'PROJECTMAN_SES_SECRET_ACCESS_KEY',
  'PROJECTMAN_SES_SESSION_TOKEN',
] as const;

/** The start stops with this: the e-mail login is switched on and its settings are missing or wrong. */
export class EmailLoginNotConfiguredError extends Error {
  readonly code = EMAIL_LOGIN_NOT_CONFIGURED;

  /** `problem` names variables only, never a value. */
  constructor(problem: string) {
    super(`${EMAIL_LOGIN_NOT_CONFIGURED}: ${problem}`);
    this.name = 'EmailLoginNotConfiguredError';
  }
}

const REQUIRED = [
  'PROJECTMAN_SES_REGION',
  'PROJECTMAN_SES_FROM',
  'PROJECTMAN_SES_ACCESS_KEY_ID',
  'PROJECTMAN_SES_SECRET_ACCESS_KEY',
] as const;

/**
 * `PROJECTMAN_EMAIL_LOGIN_ENABLED` is `0` (default) or `1`. Off: null, and the other variables are not
 * looked at. On: the region, the sender and the two keys are required, the session token is optional.
 * Reads the object it is given and writes nothing; the caller scrubs it with `scrubEmailLoginEnv`.
 */
export function parseEmailLoginEnv(
  env: Readonly<Record<string, string | undefined>>,
): SesEmailCodeMailerOptions | null {
  const enabled = env.PROJECTMAN_EMAIL_LOGIN_ENABLED?.trim() || '0';
  if (enabled !== '0' && enabled !== '1')
    throw new EmailLoginNotConfiguredError('PROJECTMAN_EMAIL_LOGIN_ENABLED must be 0 or 1');
  if (enabled === '0') return null;
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new EmailLoginNotConfiguredError(`missing ${missing.join(', ')}`);
  const region = env.PROJECTMAN_SES_REGION!.trim();
  if (!isSesRegion(region))
    throw new EmailLoginNotConfiguredError('PROJECTMAN_SES_REGION is not an AWS region name');
  const sessionToken = env.PROJECTMAN_SES_SESSION_TOKEN?.trim();
  return {
    region,
    from: env.PROJECTMAN_SES_FROM!.trim(),
    credentials: {
      accessKeyId: env.PROJECTMAN_SES_ACCESS_KEY_ID!.trim(),
      secretAccessKey: env.PROJECTMAN_SES_SECRET_ACCESS_KEY!.trim(),
      ...(sessionToken ? { sessionToken } : {}),
    },
  };
}

/**
 * Removes the e-mail login variables from the environment once they are read, so no process the server
 * starts afterwards (git, gh, a shell) inherits the keys. The runner's child environment drops every
 * `PROJECTMAN_` name as well; this is the second layer.
 */
export function scrubEmailLoginEnv(env: Record<string, string | undefined>): void {
  for (const name of EMAIL_LOGIN_ENV_NAMES) delete env[name];
}
