import { describe, expect, it, vi } from 'vitest';
import { EmailSendError, createSesEmailSender, encodedFrom } from './ses-sender';

const options = {
  region: 'eu-central-1',
  credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
  configurationSet: null,
} as const;

const FROM = 'project@example.test';

const sesMocks = vi.hoisted(() => {
  const send = vi.fn(async (command: { input: Record<string, unknown> }) => ({
    MessageId: 'provider-id',
    command,
  }));
  const constructor = vi.fn(() => ({ send }));
  return { send, constructor };
});

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: sesMocks.constructor,
  SendEmailCommand: class {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

describe('createSesEmailSender', () => {
  it('encodes the display name and pinpoints the configured SES endpoint', async () => {
    const mailer = createSesEmailSender({ ...options, endpoint: 'https://ses.example.test' });
    const result = await mailer.send({
      to: 'person@example.test',
      from: FROM,
      fromName: 'Dev "D"',
      replyTo: 'r-ar-token@example.test',
      headers: [
        { name: 'In-Reply-To', value: '<parent@example.test>' },
        { name: 'References', value: '<root@example.test> <parent@example.test>' },
      ],
      subject: 'Summary',
      text: 'Ready',
      html: '<p>Ready</p>',
    });

    expect(result).toEqual({ providerId: 'provider-id' });
    expect(encodedFrom('Dev "D"', FROM)).toBe(
      `=?UTF-8?B?${Buffer.from('Dev  D').toString('base64')}?= <${FROM}>`,
    );
    expect(sesMocks.constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        region: options.region,
        endpoint: 'https://ses.example.test',
        credentials: options.credentials,
      }),
    );
    const command = sesMocks.send.mock.calls[0]![0] as unknown as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Content: {
        Simple: {
          Headers: [
            { Name: 'In-Reply-To', Value: '<parent@example.test>' },
            { Name: 'References', Value: '<root@example.test> <parent@example.test>' },
          ],
        },
      },
      Destination: { ToAddresses: ['person@example.test'] },
      ReplyToAddresses: ['r-ar-token@example.test'],
    });
  });

  it('sanitizes a provider error into a send failure', async () => {
    const mailer = createSesEmailSender(options);

    await expect(
      mailer.send({
        to: 'not an address',
        from: FROM,
        fromName: 'Dev',
        replyTo: 'r-ar-token@example.test',
        subject: 'Summary',
        text: 'Ready',
        html: '<p>Ready</p>',
      }),
    ).rejects.toMatchObject(new EmailSendError('not_configured'));
  });

  it('sends no ReplyToAddresses without a reply address', async () => {
    sesMocks.send.mockClear();
    const mailer = createSesEmailSender(options);
    await mailer.send({
      to: 'person@example.test',
      from: FROM,
      fromName: 'Dev',
      subject: 'Summary',
      text: 'Ready',
      html: '<p>Ready</p>',
    });
    const command = sesMocks.send.mock.calls[0]![0] as unknown as { input: Record<string, unknown> };
    expect(command.input).not.toHaveProperty('ReplyToAddresses');
  });

  it('turns an IAM sender refusal into fromRefused', async () => {
    sesMocks.send.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    );
    const mailer = createSesEmailSender(options);
    await expect(
      mailer.send({
        to: 'person@example.test',
        from: FROM,
        fromName: 'Dev',
        subject: 'Summary',
        text: 'Ready',
        html: '<p>Ready</p>',
      }),
    ).rejects.toMatchObject({ reason: 'unavailable', fromRefused: true });
  });
});
