import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { hu } from '@projectman/templates';
import { EmailCodeDeliveryError } from '../../contracts';
import type { EmailCodeDeliveryReason, EmailCodeMailInput, EmailCodeMailer } from '../../contracts';

export interface SesEmailCodeMailerOptions {
  region: string;
  /** The sender, an address (or `Name <address>`) of a verified SES identity. */
  from: string;
  /** Explicit keys. The SDK's credential chain (environment, profile, instance role) is never consulted. */
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Tests: the base URL of a fake SES. Absent: the region's SES endpoint. */
  endpoint?: string;
}

/** A region name as AWS writes it (`eu-central-1`, `us-gov-west-1`): it becomes part of the host name. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
/** One plain address: no display name, comma, angle bracket, quote or white space (nothing that adds a header or a recipient). */
const ADDRESS = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+$/;
let ses: Promise<typeof import('@aws-sdk/client-sesv2')> | undefined;

export function isSesRegion(region: string): boolean {
  return REGION.test(region);
}

/** SES error names that say what went wrong without carrying the message or the address. */
const REASONS: Readonly<Record<string, EmailCodeDeliveryReason>> = {
  MessageRejected: 'rejected',
  MailFromDomainNotVerifiedException: 'rejected',
  AccountSuspendedException: 'rejected',
  SendingPausedException: 'rejected',
  TooManyRequestsException: 'throttled',
  LimitExceededException: 'throttled',
  Throttling: 'throttled',
  ThrottlingException: 'throttled',
  UnrecognizedClientException: 'credentials',
  InvalidSignatureException: 'credentials',
  AccessDeniedException: 'credentials',
  ExpiredTokenException: 'credentials',
  ExpiredToken: 'credentials',
};

function reasonOf(error: unknown): EmailCodeDeliveryReason {
  const name = error instanceof Error ? error.name : '';
  return REASONS[name] ?? 'unavailable';
}

/** `2026. 10. 14. 19:42`: the moment in the Hungarian locale's time zone, because the mail is Hungarian. */
function validUntil(expiresAt: string): string {
  const moment = new Date(expiresAt);
  if (Number.isNaN(moment.getTime())) throw new TypeError('expiresAt must be an ISO date-time');
  return new Intl.DateTimeFormat('hu-HU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: hu.timezone,
  }).format(moment);
}

/**
 * Sends the login code through the SES v2 `SendEmail` operation. The adapter keeps nothing and logs
 * nothing: the address and the code stay in the request. Any provider failure becomes an
 * `EmailCodeDeliveryError` that holds no text of the provider's error.
 */
export function createSesEmailCodeMailer(options: SesEmailCodeMailerOptions): EmailCodeMailer {
  if (!REGION.test(options.region)) throw new TypeError('the SES region is not an AWS region name');
  const { accessKeyId, secretAccessKey, sessionToken } = options.credentials;
  const clientOptions = {
    region: options.region,
    // Pinned, so an AWS_ENDPOINT_URL in the environment cannot redirect the mail.
    endpoint: options.endpoint ?? `https://email.${options.region}.amazonaws.com`,
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
  };
  let client: SESv2Client | undefined;
  return {
    async send(input: EmailCodeMailInput): Promise<void> {
      if (!ADDRESS.test(input.to)) throw new TypeError('the recipient is not a plain address');
      if (!input.code) throw new TypeError('the code is empty');
      const { SESv2Client, SendEmailCommand } = await (ses ??= import('@aws-sdk/client-sesv2'));
      client ??= new SESv2Client(clientOptions);
      const text = hu.emailLoginCode;
      const command = new SendEmailCommand({
        FromEmailAddress: options.from,
        Destination: { ToAddresses: [input.to] },
        Content: {
          Simple: {
            Subject: { Data: text.subject, Charset: 'UTF-8' },
            Body: {
              Text: {
                Data: text.text({ code: input.code, validUntil: validUntil(input.expiresAt) }),
                Charset: 'UTF-8',
              },
            },
          },
        },
      });
      try {
        await client.send(command);
      } catch (error) {
        throw new EmailCodeDeliveryError(reasonOf(error));
      }
    },
  };
}
