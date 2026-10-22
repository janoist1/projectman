export { createEmailLoginService, EMAIL_LOGIN_LIMITS } from './login-service';
export type { EmailLoginService } from './login-service';
export { createSesEmailCodeMailer } from './ses-mailer';
export {
  EMAIL_LOGIN_ENV_NAMES,
  EmailLoginNotConfiguredError,
  parseEmailLoginEnv,
  scrubEmailLoginEnv,
} from './config';
