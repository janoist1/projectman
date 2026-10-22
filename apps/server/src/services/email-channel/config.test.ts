import { describe, expect, it } from 'vitest';
import { EmailChannelNotConfiguredError, parseEmailChannelEnv, scrubEmailChannelEnv } from './config';

const complete = {
  PROJECTMAN_EMAIL_CHANNEL_ENABLED: '1',
  PROJECTMAN_SES_REGION: 'eu-central-1',
  PROJECTMAN_SES_FROM: 'project@example.test',
  PROJECTMAN_SES_ACCESS_KEY_ID: 'key',
  PROJECTMAN_SES_SECRET_ACCESS_KEY: 'secret',
  PROJECTMAN_EMAIL_REPLY_DOMAIN: 'reply.example.test',
} as const;

describe('parseEmailChannelEnv', () => {
  it('parses the optional channel settings', () => {
    expect(
      parseEmailChannelEnv({
        ...complete,
        PROJECTMAN_SES_SESSION_TOKEN: 'session',
        PROJECTMAN_EMAIL_CONFIGURATION_SET: 'set',
        PROJECTMAN_EMAIL_QUEUE_URL: 'https://sqs.example.test/queue',
      }),
    ).toEqual({
      region: 'eu-central-1',
      from: 'project@example.test',
      credentials: {
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        sessionToken: 'session',
      },
      configurationSet: 'set',
      replyDomain: 'reply.example.test',
      queueUrl: 'https://sqs.example.test/queue',
    });
  });

  it('returns null while the channel is off', () => {
    expect(parseEmailChannelEnv({ ...complete, PROJECTMAN_EMAIL_CHANNEL_ENABLED: '0' })).toBeNull();
  });

  it.each([
    ['enabled', { PROJECTMAN_EMAIL_CHANNEL_ENABLED: 'yes' }],
    ['region', { PROJECTMAN_SES_REGION: 'not-a-region' }],
    ['from', { PROJECTMAN_SES_FROM: '' }],
    ['access key id', { PROJECTMAN_SES_ACCESS_KEY_ID: '' }],
    ['secret access key', { PROJECTMAN_SES_SECRET_ACCESS_KEY: '' }],
    ['reply domain', { PROJECTMAN_EMAIL_REPLY_DOMAIN: '' }],
  ] as const)('refuses an invalid %s', (_name, override) => {
    expect(() => parseEmailChannelEnv({ ...complete, ...override })).toThrow(EmailChannelNotConfiguredError);
  });

  it('removes every channel and shared SES variable', () => {
    const env = { ...complete, PROJECTMAN_SES_SESSION_TOKEN: 'session' };
    scrubEmailChannelEnv(env);
    expect(Object.keys(env)).toEqual([]);
  });
});
