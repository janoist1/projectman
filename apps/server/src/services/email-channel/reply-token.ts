import { createHmac, randomBytes } from 'node:crypto';

/** 26 base32 characters (130 bits); the address carries it, the database keeps only its keyed hash. */
export function replyToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const number = BigInt(`0x${randomBytes(16).toString('hex')}`);
  let value = number;
  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

export function replyTokenHash(key: Buffer, token: string): string {
  return createHmac('sha256', key).update(`reply:${token}`).digest('hex');
}
