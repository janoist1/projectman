import { MAX_ATTACHMENT_FILE_NAME_BYTES } from '@projectman/shared';

export const FALLBACK_FILE_NAME = 'file';

// Control characters, line and paragraph separators, bidirectional overrides and isolates (they
// make a name read differently from how it ends), the byte order mark and the replacement char.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufffd]/g;

function truncateBytes(text: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * The original file name as safe metadata: the last path segment (either separator), no control
 * or direction-changing characters, no leading or trailing blanks and dots, at most 255 bytes
 * with the extension kept. It only ever labels the file: storage names come from generated ids.
 */
export function sanitizeFileName(raw: string | undefined): string {
  const lastSegment = (raw ?? '').normalize('NFC').split(/[\\/]/).pop() ?? '';
  const cleaned = lastSegment
    .replace(UNSAFE, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .replace(/\s+/g, ' ');
  if (cleaned === '') return FALLBACK_FILE_NAME;
  if (Buffer.byteLength(cleaned) <= MAX_ATTACHMENT_FILE_NAME_BYTES) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && Buffer.byteLength(cleaned) - dot <= 32 ? cleaned.slice(dot) : '';
  const stem = truncateBytes(
    extension ? cleaned.slice(0, dot) : cleaned,
    MAX_ATTACHMENT_FILE_NAME_BYTES - Buffer.byteLength(extension),
  );
  return `${stem.replace(/[\s.]+$/g, '') || FALLBACK_FILE_NAME}${extension}`;
}

/**
 * A `Content-Disposition` value for this file name: a plain ASCII fallback (`filename`) and the
 * real name percent encoded (`filename*`, RFC 5987/8187); nothing from the name can end the
 * header value or add parameters.
 */
export function contentDisposition(disposition: 'inline' | 'attachment', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
