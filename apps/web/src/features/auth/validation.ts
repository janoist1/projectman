import { t } from '../../i18n/t';

export interface SetupErrors {
  name?: string;
  email?: string;
  password?: string;
  setupCode?: string;
}

export function validateSetup(
  values: { name: string; email: string; password: string; setupCode: string },
  needsSetupCode = false,
): SetupErrors {
  const errors: SetupErrors = {};
  if (needsSetupCode && !values.setupCode.trim()) errors.setupCode = t('auth.validation.setupCodeRequired');
  if (!values.name.trim()) errors.name = t('auth.validation.nameRequired');
  if (!/^\S+@\S+\.\S+$/.test(values.email.trim())) errors.email = t('auth.validation.emailInvalid');
  if (values.password.length < 8) errors.password = t('auth.validation.passwordShort');
  return errors;
}
