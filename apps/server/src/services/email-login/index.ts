export { createEmailLoginService, EMAIL_LOGIN_CODE_REQUESTED, EMAIL_LOGIN_LIMITS } from './login-service';
export type { EmailLoginService } from './login-service';
export { createSesEmailCodeMailer } from './ses-mailer';
export type { SesEmailCodeMailerOptions } from './ses-mailer';
export {
  EMAIL_LOGIN_ENV_NAMES,
  EMAIL_LOGIN_NOT_CONFIGURED,
  EmailLoginNotConfiguredError,
  parseEmailLoginEnv,
  scrubEmailLoginEnv,
} from './config';
