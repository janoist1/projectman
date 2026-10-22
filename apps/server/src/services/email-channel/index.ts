export { createEmailChannelService } from './service';
export type { DeliveryEvent, EmailChannelService, EmailInbound, InboundMail, Verdict } from './types';
export type { EmailChannelEnv } from './config';
export {
  EMAIL_CHANNEL_ENV_NAMES,
  EMAIL_CHANNEL_NOT_CONFIGURED,
  EmailChannelNotConfiguredError,
  parseEmailChannelEnv,
  scrubEmailChannelEnv,
} from './config';
export { createSesEmailSender, EmailSendError } from './ses-sender';
export type { EmailSender, OutboundMail, SesEmailSenderOptions } from './ses-sender';
export { renderEmail } from './render';
