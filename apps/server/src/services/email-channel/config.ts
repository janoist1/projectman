import { isSesRegion } from './ses-sender';
import type { EmailSender } from './ses-sender';

export const EMAIL_CHANNEL_NOT_CONFIGURED = 'email_not_configured';

/** Every SES variable of the outgoing and one-time-login e-mail channels; none reaches a child process. */
export const EMAIL_CHANNEL_ENV_NAMES = [
  'PROJECTMAN_EMAIL_CHANNEL_ENABLED',
  'PROJECTMAN_SES_REGION',
  'PROJECTMAN_SES_FROM',
  'PROJECTMAN_SES_ACCESS_KEY_ID',
  'PROJECTMAN_SES_SECRET_ACCESS_KEY',
  'PROJECTMAN_SES_SESSION_TOKEN',
  'PROJECTMAN_EMAIL_CONFIGURATION_SET',
  'PROJECTMAN_EMAIL_REPLY_DOMAIN',
  'PROJECTMAN_EMAIL_QUEUE_URL',
] as const;

export class EmailChannelNotConfiguredError extends Error {
  readonly code = EMAIL_CHANNEL_NOT_CONFIGURED;

  constructor(problem: string) {
    super(`${EMAIL_CHANNEL_NOT_CONFIGURED}: ${problem}`);
    this.name = 'EmailChannelNotConfiguredError';
  }
}

export interface EmailChannelEnv {
  region: string;
  from: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  configurationSet: string | null;
  replyDomain: string;
  queueUrl: string | null;
}

export function parseEmailChannelEnv(
  env: Readonly<Record<string, string | undefined>>,
): EmailChannelEnv | null {
  const enabled = env.PROJECTMAN_EMAIL_CHANNEL_ENABLED?.trim() || '0';
  if (enabled !== '0' && enabled !== '1')
    throw new EmailChannelNotConfiguredError('PROJECTMAN_EMAIL_CHANNEL_ENABLED must be 0 or 1');
  if (enabled === '0') return null;
  for (const name of [
    'PROJECTMAN_SES_REGION',
    'PROJECTMAN_SES_FROM',
    'PROJECTMAN_SES_ACCESS_KEY_ID',
    'PROJECTMAN_SES_SECRET_ACCESS_KEY',
    'PROJECTMAN_EMAIL_REPLY_DOMAIN',
  ] as const) {
    if (!env[name]?.trim()) throw new EmailChannelNotConfiguredError(`missing ${name}`);
  }
  const region = env.PROJECTMAN_SES_REGION!.trim();
  if (!isSesRegion(region))
    throw new EmailChannelNotConfiguredError('PROJECTMAN_SES_REGION is not an AWS region name');
  const sessionToken = env.PROJECTMAN_SES_SESSION_TOKEN?.trim();
  return {
    region,
    from: env.PROJECTMAN_SES_FROM!.trim(),
    credentials: {
      accessKeyId: env.PROJECTMAN_SES_ACCESS_KEY_ID!.trim(),
      secretAccessKey: env.PROJECTMAN_SES_SECRET_ACCESS_KEY!.trim(),
      ...(sessionToken ? { sessionToken } : {}),
    },
    configurationSet: env.PROJECTMAN_EMAIL_CONFIGURATION_SET?.trim() || null,
    replyDomain: env.PROJECTMAN_EMAIL_REPLY_DOMAIN!.trim(),
    queueUrl: env.PROJECTMAN_EMAIL_QUEUE_URL?.trim() || null,
  };
}

export function scrubEmailChannelEnv(env: Record<string, string | undefined>): void {
  for (const name of EMAIL_CHANNEL_ENV_NAMES) delete env[name];
}
