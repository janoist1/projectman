/**
 * Reads the server name (SNI) of a TLS ClientHello, so the egress proxy can refuse a tunnel
 * whose TLS goes to another name than the one allowed (domain fronting over a shared front).
 *
 * Result of `parseClientHello(buffer)`:
 * - `{ status: 'incomplete' }`: more bytes are needed;
 * - `{ status: 'not_tls' }`: the bytes are not a TLS handshake starting with a ClientHello;
 * - `{ status: 'hello', serverName }`: the ClientHello, with its host name or null when absent.
 */
export type ClientHello =
  | { status: 'incomplete' }
  | { status: 'not_tls' }
  | { status: 'hello'; serverName: string | null };

const RECORD_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXTENSION_SERVER_NAME = 0x0000;
/** A ClientHello is far smaller; anything longer is not one we accept. */
export const MAX_CLIENT_HELLO_BYTES = 64 * 1024;

/** The handshake bytes carried by the leading handshake records (a ClientHello may span records). */
function handshakeBytes(buffer: Buffer): { bytes: Buffer; complete: boolean } | null {
  const parts: Buffer[] = [];
  let offset = 0;
  let total = 0;
  let expected: number | null = null;
  while (offset + 5 <= buffer.length) {
    if (buffer[offset] !== RECORD_HANDSHAKE || buffer[offset + 1] !== 0x03) return null;
    const length = buffer.readUInt16BE(offset + 3);
    if (length === 0 || length > 16_384 + 2048) return null;
    if (offset + 5 + length > buffer.length) break;
    parts.push(buffer.subarray(offset + 5, offset + 5 + length));
    total += length;
    offset += 5 + length;
    if (expected === null && total >= 4) {
      const head = Buffer.concat(parts);
      if (head[0] !== HANDSHAKE_CLIENT_HELLO) return null;
      expected = 4 + head.readUIntBE(1, 3);
    }
    if (expected !== null && total >= expected) return { bytes: Buffer.concat(parts).subarray(0, expected), complete: true };
  }
  if (buffer.length >= 1 && buffer[0] !== RECORD_HANDSHAKE) return null;
  if (buffer.length >= 2 && buffer[1] !== 0x03) return null;
  return { bytes: Buffer.concat(parts), complete: false };
}

export function parseClientHello(buffer: Buffer): ClientHello {
  if (buffer.length > MAX_CLIENT_HELLO_BYTES) return { status: 'not_tls' };
  const handshake = handshakeBytes(buffer);
  if (!handshake) return { status: 'not_tls' };
  if (!handshake.complete) return { status: 'incomplete' };
  const hello = handshake.bytes;
  try {
    let p = 4; // type + length
    p += 2 + 32; // client_version + random
    p += 1 + hello[p]!; // session_id
    p += 2 + hello.readUInt16BE(p); // cipher_suites
    p += 1 + hello[p]!; // compression_methods
    if (p === hello.length) return { status: 'hello', serverName: null };
    const extensionsEnd = p + 2 + hello.readUInt16BE(p);
    p += 2;
    if (extensionsEnd > hello.length) return { status: 'not_tls' };
    while (p + 4 <= extensionsEnd) {
      const type = hello.readUInt16BE(p);
      const length = hello.readUInt16BE(p + 2);
      const start = p + 4;
      if (start + length > extensionsEnd) return { status: 'not_tls' };
      if (type === EXTENSION_SERVER_NAME) {
        let q = start + 2; // server_name_list length
        const listEnd = start + 2 + hello.readUInt16BE(start);
        while (q + 3 <= listEnd) {
          const nameType = hello[q]!;
          const nameLength = hello.readUInt16BE(q + 1);
          const name = hello.subarray(q + 3, q + 3 + nameLength);
          if (nameType === 0) {
            const text = name.toString('ascii');
            return /^[\x21-\x7e]+$/.test(text)
              ? { status: 'hello', serverName: text.toLowerCase().replace(/\.$/, '') }
              : { status: 'not_tls' };
          }
          q += 3 + nameLength;
        }
        return { status: 'hello', serverName: null };
      }
      p = start + length;
    }
    return { status: 'hello', serverName: null };
  } catch {
    return { status: 'not_tls' };
  }
}
