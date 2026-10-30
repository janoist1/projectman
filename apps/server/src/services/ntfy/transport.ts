import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { ntfyServerOf } from '@projectman/shared';
import type { PushFailure } from '@projectman/shared';
import type { NtfySendInput, NtfySendOutcome, NtfyTransport } from '../../contracts';

/** True for an address that is not on the public internet: loopback, private, link-local, multicast, reserved. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const plain = mapped ? mapped[1]! : address;
  if (isIP(plain) === 4) {
    const [a, b, c] = plain.split('.').map(Number) as [number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(plain) === 6) {
    const lower = plain.toLowerCase();
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith('ff') ||
      lower.startsWith('::ffff:')
    );
  }
  return true;
}
/** Resolves the host and refuses a private answer, so the connection itself never reaches an internal address. */
function publicLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (error: Error | null, address?: string | LookupAddress[], family?: number) => void,
): void {
  const all: LookupAllOptions = { ...options, all: true };
  dnsLookup(hostname, all, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address)))
      return callback(Object.assign(new Error('Address refused'), { code: 'EACCES' }));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}
/** Converts an HTTP status or network error without retaining the topic, the address or the body. */
export function ntfyOutcomeOf(status: number | undefined, code?: string): NtfySendOutcome {
  if (status && status >= 200 && status < 300) return { result: 'ok' };
  const failure: PushFailure =
    status === 429
      ? 'rate_limited'
      : status === 413
        ? 'payload_too_large'
        : status && status >= 400 && status < 500
          ? 'rejected'
          : status && status >= 500 && status < 600
            ? 'service_error'
            : code === 'ETIMEDOUT'
              ? 'timeout'
              : code === 'EACCES'
                ? 'rejected'
                : 'network';
  return { result: 'failed', failure };
}
/**
 * Publishes with ntfy's JSON API (UTF-8 text, and the topic stays out of the URL). Redirects are not followed
 * and the answer is not read.
 */
export function createNtfyTransport(): NtfyTransport {
  return {
    send(input: NtfySendInput): Promise<NtfySendOutcome> {
      const server = ntfyServerOf(input.server);
      if (!server) return Promise.resolve({ result: 'failed', failure: 'rejected' });
      const body = JSON.stringify({
        topic: input.topic,
        title: input.title,
        message: input.message,
        priority: input.priority === 'high' ? 4 : 3,
        ...(input.click ? { click: input.click } : {}),
      });
      return new Promise((resolve) => {
        let done = false;
        const finish = (outcome: NtfySendOutcome) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(outcome);
        };
        const req = request(
          server,
          {
            method: 'POST',
            lookup: publicLookup as never,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          },
          (res) => {
            res.resume();
            finish(ntfyOutcomeOf(res.statusCode));
          },
        );
        const timer = setTimeout(() => {
          finish({ result: 'failed', failure: 'timeout' });
          req.destroy();
        }, input.timeoutMs);
        req.on('error', (error: NodeJS.ErrnoException) => finish(ntfyOutcomeOf(undefined, error.code)));
        req.end(body);
      });
    },
  };
}
