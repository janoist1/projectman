export { createSesEmailCodeMailer } from './ses-mailer';
export type { SesEmailCodeMailerOptions } from './ses-mailer';
export {
  EMAIL_LOGIN_ENV_NAMES,
  EMAIL_LOGIN_NOT_CONFIGURED,
  EmailLoginNotConfiguredError,
  parseEmailLoginEnv,
  scrubEmailLoginEnv,
} from './config';
