import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hu } from '@projectman/templates';
import { EMAIL_CODE_DELIVERY_FAILED, EmailCodeDeliveryError } from '../../contracts';
import { createSesEmailCodeMailer } from './index';

/** A fake SES v2 endpoint on the loopback: records the requests and answers as a test says. */
interface FakeRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let requests: FakeRequest[];
let answer: { status: number; type?: string; body: unknown };
let endpoint: string;

const KEYS = { accessKeyId: 'AKIAEXPLICITEXAMPLE', secretAccessKey: 'explicit-secret-example-value' };
const TO = 'ugyfel.teszt@example.test';
const CODE = '482913';
const EXPIRES_AT = '2026-10-14T17:42:00.000Z';

beforeEach(async () => {
  requests = [];
  answer = { status: 200, body: { MessageId: 'fake-message-id' } };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(answer.status, {
        'content-type': 'application/json',
        ...(answer.type ? { 'x-amzn-errortype': answer.type } : {}),
      });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((done) => server.close(() => done()));
});

function mailer(extra: { sessionToken?: string; region?: string } = {}) {
  return createSesEmailCodeMailer({
    region: extra.region ?? 'eu-central-1',
    from: 'Projectman <belepes@istvan.io>',
    credentials: { ...KEYS, ...(extra.sessionToken ? { sessionToken: extra.sessionToken } : {}) },
    endpoint,
  });
}

describe('the SES e-mail code mailer', () => {
  it('sends one SendEmail request with the sender, the recipient and the code in the Hungarian text', async () => {
    await mailer().send({ to: TO, code: CODE, expiresAt: EXPIRES_AT });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v2/email/outbound-emails');
    const body = JSON.parse(request.body);
    expect(body.FromEmailAddress).toBe('Projectman <belepes@istvan.io>');
    expect(body.Destination).toEqual({ ToAddresses: [TO] });
    expect(body.Content.Simple.Subject.Data).toBe('Belépési kódod');
    const text: string = body.Content.Simple.Body.Text.Data;
    expect(text).toContain(`A belépési kódod: ${CODE}`);
    // 17:42 UTC is 19:42 in Budapest in October (CEST).
    expect(text).toContain('19:42');
    expect(text).toContain('2026');
    expect(body.Content.Simple.Body.Text.Charset).toBe('UTF-8');
  });

  it('chooses the template by the purpose of the code', async () => {
    await mailer().send({ to: TO, code: CODE, expiresAt: EXPIRES_AT, purpose: 'password' });
    await mailer().send({ to: TO, code: CODE, expiresAt: EXPIRES_AT, purpose: 'login' });
    const subjects = requests.map((r) => JSON.parse(r.body).Content.Simple.Subject.Data);
    expect(subjects).toEqual([hu.passwordResetCode.subject, hu.emailLoginCode.subject]);
    const text: string = JSON.parse(requests[0]!.body).Content.Simple.Body.Text.Data;
    expect(text).toContain(CODE);
  });

  it('signs for the region with the explicit keys and the session token', async () => {
    await mailer({ sessionToken: 'explicit-session-token' }).send({
      to: TO,
      code: CODE,
      expiresAt: EXPIRES_AT,
    });
    const headers = requests[0]!.headers;
    expect(headers.authorization).toContain(`Credential=${KEYS.accessKeyId}/`);
    expect(headers.authorization).toContain('/eu-central-1/ses/aws4_request');
    expect(headers['x-amz-security-token']).toBe('explicit-session-token');
  });

  it('sends no session token when none is given', async () => {
    await mailer().send({ to: TO, code: CODE, expiresAt: EXPIRES_AT });
    expect(requests[0]!.headers['x-amz-security-token']).toBeUndefined();
  });

  it('ignores the ambient AWS environment: no profile, no credential chain', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAAMBIENTSHOULDNOTBEUSED');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', 'ambient-session-token');
    vi.stubEnv('AWS_PROFILE', 'ambient-profile');
    vi.stubEnv('AWS_REGION', 'ap-southeast-2');
    await mailer().send({ to: TO, code: CODE, expiresAt: EXPIRES_AT });
    const headers = requests[0]!.headers;
    expect(headers.authorization).toContain(`Credential=${KEYS.accessKeyId}/`);
    expect(headers.authorization).toContain('/eu-central-1/ses/');
    expect(JSON.stringify(headers)).not.toMatch(/ambient/i);
  });

  it('turns a provider rejection into a sanitized error without the address, the code or a key', async () => {
    answer = {
      status: 400,
      type: 'MessageRejected',
      body: { message: `Email address is not verified: ${TO} ${CODE} ${KEYS.secretAccessKey}` },
    };
    const error = await mailer()
      .send({ to: TO, code: CODE, expiresAt: EXPIRES_AT })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(EmailCodeDeliveryError);
    const delivery = error as EmailCodeDeliveryError;
    expect(delivery.code).toBe(EMAIL_CODE_DELIVERY_FAILED);
    expect(delivery.reason).toBe('rejected');
    expect(delivery.cause).toBeUndefined();
    const everything = [
      delivery.message,
      delivery.stack ?? '',
      JSON.stringify(delivery),
      String(delivery),
      Object.getOwnPropertyNames(delivery).join(),
    ].join('\n');
    for (const secret of [TO, CODE, KEYS.secretAccessKey, KEYS.accessKeyId, 'ugyfel.teszt'])
      expect(everything).not.toContain(secret);
  });

  it.each([
    ['TooManyRequestsException', 429, 'throttled'],
    ['UnrecognizedClientException', 403, 'credentials'],
    ['NotFoundException', 404, 'unavailable'],
  ] as const)('maps %s (HTTP %i) to the reason %s without keeping its text', async (type, status, reason) => {
    answer = { status, type, body: { message: `${TO} ${CODE}` } };
    await expect(mailer().send({ to: TO, code: CODE, expiresAt: EXPIRES_AT })).rejects.toMatchObject({
      name: 'EmailCodeDeliveryError',
      code: 'email_code_delivery_failed',
      reason,
    });
  });

  it('turns an unreachable endpoint into the same error', async () => {
    await new Promise<void>((done) => server.close(() => done()));
    server = createServer();
    await expect(mailer().send({ to: TO, code: CODE, expiresAt: EXPIRES_AT })).rejects.toBeInstanceOf(
      EmailCodeDeliveryError,
    );
  }, 20_000);

  it('logs nothing: neither the address nor the code reach the console or the standard streams', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    await mailer().send({ to: TO, code: CODE, expiresAt: EXPIRES_AT });
    answer = { status: 400, type: 'MessageRejected', body: { message: TO } };
    await mailer()
      .send({ to: TO, code: CODE, expiresAt: EXPIRES_AT })
      .catch(() => undefined);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a recipient that is not one plain address, before any request', async () => {
    for (const to of [
      'a@example.test, b@example.test',
      'Name <a@example.test>',
      'a@example.test\r\nBcc: b@example.test',
      'no-at-sign',
      '',
    ])
      await expect(mailer().send({ to, code: CODE, expiresAt: EXPIRES_AT })).rejects.toBeInstanceOf(
        TypeError,
      );
    expect(requests).toHaveLength(0);
  });

  it('refuses an empty code and an expiry that is not a date, before any request', async () => {
    await expect(mailer().send({ to: TO, code: '', expiresAt: EXPIRES_AT })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(mailer().send({ to: TO, code: CODE, expiresAt: 'tomorrow-ish' })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(requests).toHaveLength(0);
  });

  it('refuses a region that is not an AWS region name', () => {
    for (const region of ['', 'eu', 'EU-CENTRAL-1', 'eu-central-1.evil.test', 'eu-central-1/x'])
      expect(() => mailer({ region })).toThrow(TypeError);
  });
});
