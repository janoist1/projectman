import type { Attachment } from '@projectman/shared';
import { formatTimestamp, oneLine, PLAIN_STYLE, type TextStyle } from './text';

/** Longer file names are shortened (they are metadata people chose). */
const FILE_NAME_LIMIT = 120;

/** "512 B", "48.2 kB", "25 MB": decimal units, like the 25 MB attachment limit. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${Number(value.toFixed(1))} ${units[unit]}`;
}

/**
 * One attachment: id, file name, media type, size, uploader and time, e.g.
 * `att_x1 "login-error.png" · image/png · 48.2 kB · by owner, 2026-09-29 08:30 UTC`.
 */
export function describeAttachment(
  attachment: Attachment,
  style: Pick<TextStyle, 'code'> = PLAIN_STYLE,
): string {
  const by = attachment.uploadedBy.handle ? style.code(attachment.uploadedBy.handle) : 'the system';
  return [
    `${style.code(attachment.id)} "${oneLine(attachment.fileName, FILE_NAME_LIMIT)}"`,
    attachment.mediaType,
    formatBytes(attachment.size),
    `by ${by}, ${formatTimestamp(attachment.createdAt)}`,
  ].join(' · ');
}
