import { expect, test, vi } from 'vitest';
import { createSesEmailCodeMailer } from './ses-mailer';

const sdk = vi.hoisted(() => ({
  loaded: vi.fn(),
  client: vi.fn(),
  command: vi.fn(),
  send: vi.fn().mockResolvedValue({ MessageId: 'fake-message' }),
}));

vi.mock('@aws-sdk/client-sesv2', () => {
  sdk.loaded();
  return {
    SESv2Client: class {
      constructor(options: unknown) {
        sdk.client(options);
      }
      send = sdk.send;
    },
    SendEmailCommand: class {
      constructor(input: unknown) {
        sdk.command(input);
      }
    },
  };
});

test('defers the SDK until the first valid send and shares one client across concurrent sends', async () => {
  const mailer = createSesEmailCodeMailer({
    region: 'eu-central-1',
    from: 'login@example.test',
    credentials: { accessKeyId: 'fake-access-key', secretAccessKey: 'fake-secret' },
  });
  const input = {
    to: 'client@example.test',
    code: '482913',
    expiresAt: '2026-10-14T17:42:00.000Z',
    language: 'hu' as const,
  };
  expect(sdk.loaded).not.toHaveBeenCalled();
  expect(sdk.client).not.toHaveBeenCalled();
  await expect(mailer.send({ ...input, to: 'invalid' })).rejects.toThrow('not a plain address');
  expect(sdk.loaded).not.toHaveBeenCalled();
  await Promise.all([mailer.send(input), mailer.send(input)]);
  expect(sdk.loaded).toHaveBeenCalledTimes(1);
  expect(sdk.client).toHaveBeenCalledTimes(1);
  expect(sdk.client).toHaveBeenCalledWith({
    region: 'eu-central-1',
    endpoint: 'https://email.eu-central-1.amazonaws.com',
    credentials: { accessKeyId: 'fake-access-key', secretAccessKey: 'fake-secret' },
  });
  expect(sdk.send).toHaveBeenCalledTimes(2);
  expect(sdk.command).toHaveBeenCalledWith(
    expect.objectContaining({
      FromEmailAddress: 'login@example.test',
      Destination: { ToAddresses: ['client@example.test'] },
    }),
  );
});
