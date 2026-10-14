import { describe, expect, it } from 'vitest';
import {
  EMAIL_LOGIN_ENV_NAMES,
  EmailLoginNotConfiguredError,
  parseEmailLoginEnv,
  scrubEmailLoginEnv,
} from './index';

const FULL = {
  PROJECTMAN_EMAIL_LOGIN_ENABLED: '1',
  PROJECTMAN_SES_REGION: 'eu-central-1',
  PROJECTMAN_SES_FROM: 'belepes@istvan.io',
  PROJECTMAN_SES_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  PROJECTMAN_SES_SECRET_ACCESS_KEY: 'secret-example-value',
};

function failure(env: Record<string, string | undefined>): EmailLoginNotConfiguredError {
  try {
    parseEmailLoginEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(EmailLoginNotConfiguredError);
    return error as EmailLoginNotConfiguredError;
  }
  throw new Error('expected the configuration to be refused');
}

describe('the e-mail login environment', () => {
  it('is off by default, and off when 0, whatever else is set', () => {
    expect(parseEmailLoginEnv({})).toBeNull();
    expect(parseEmailLoginEnv({ PROJECTMAN_EMAIL_LOGIN_ENABLED: '0' })).toBeNull();
    expect(
      parseEmailLoginEnv({ ...FULL, PROJECTMAN_EMAIL_LOGIN_ENABLED: '0', PROJECTMAN_SES_REGION: '??' }),
    ).toBeNull();
    expect(parseEmailLoginEnv({ ...FULL, PROJECTMAN_EMAIL_LOGIN_ENABLED: '' })).toBeNull();
  });

  it('reads the region, the sender and the keys when on; the session token is optional', () => {
    expect(parseEmailLoginEnv(FULL)).toEqual({
      region: 'eu-central-1',
      from: 'belepes@istvan.io',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example-value' },
    });
    expect(
      parseEmailLoginEnv({ ...FULL, PROJECTMAN_SES_SESSION_TOKEN: 'token-example' })?.credentials,
    ).toEqual({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-example-value',
      sessionToken: 'token-example',
    });
  });

  it('stops the start with email_login_not_configured when a required name is missing or blank', () => {
    for (const name of [
      'PROJECTMAN_SES_REGION',
      'PROJECTMAN_SES_FROM',
      'PROJECTMAN_SES_ACCESS_KEY_ID',
      'PROJECTMAN_SES_SECRET_ACCESS_KEY',
    ]) {
      for (const value of [undefined, '', '  ']) {
        const error = failure({ ...FULL, [name]: value });
        expect(error.code).toBe('email_login_not_configured');
        expect(error.message).toBe(`email_login_not_configured: missing ${name}`);
      }
    }
  });

  it('refuses a switch that is neither 0 nor 1, and a region that is not a region name', () => {
    expect(failure({ ...FULL, PROJECTMAN_EMAIL_LOGIN_ENABLED: 'true' }).code).toBe(
      'email_login_not_configured',
    );
    expect(failure({ ...FULL, PROJECTMAN_SES_REGION: 'europe' }).message).toContain('PROJECTMAN_SES_REGION');
  });

  it('names variables only, never a value', () => {
    const error = failure({ ...FULL, PROJECTMAN_SES_REGION: '', PROJECTMAN_SES_FROM: '' });
    expect(error.message).toBe(
      'email_login_not_configured: missing PROJECTMAN_SES_REGION, PROJECTMAN_SES_FROM',
    );
    expect(failure({ ...FULL, PROJECTMAN_SES_REGION: 'secret-looking-value' }).message).not.toContain(
      'secret-looking-value',
    );
  });

  it('removes every e-mail login variable from the environment once read, and nothing else', () => {
    const env: Record<string, string | undefined> = {
      ...FULL,
      PROJECTMAN_SES_SESSION_TOKEN: 'token-example',
      PROJECTMAN_HOME: '/data',
      PATH: '/usr/bin',
    };
    scrubEmailLoginEnv(env);
    expect(Object.keys(env).sort()).toEqual(['PATH', 'PROJECTMAN_HOME']);
    for (const name of EMAIL_LOGIN_ENV_NAMES) expect(env).not.toHaveProperty(name);
  });
});
