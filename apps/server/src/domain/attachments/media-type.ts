import { OCTET_STREAM } from '@projectman/shared';

/** How many leading bytes the content check needs. */
export const SNIFF_BYTES = 16;

const startsWith = (head: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  head.length >= offset + signature.length && signature.every((byte, i) => head[offset + i] === byte);

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/**
 * The media type the file's own content proves, from its first bytes: PNG, JPEG, GIF, WebP or
 * PDF; anything else (HTML, SVG, a renamed file, unknown) is `application/octet-stream`. The name
 * and the type the client declared are never consulted.
 */
export function sniffMediaType(head: Uint8Array): string {
  if (startsWith(head, [0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(head, ascii('%PDF-'))) return 'application/pdf';
  return OCTET_STREAM;
}
