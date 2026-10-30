import { z } from 'zod';
import { PushFailure, PushResult, plainHttpsUrl } from './web-push';

/** The public ntfy server; the topic name is the only secret there, so the server makes the topic up. */
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
const NTFY_RESULTS = PushResult.extract(['ok', 'failed']);
export const NtfyChannelView = z.object({
  server: z.string(),
  topic: z.string(),
  enabled: z.boolean(),
  /** True when the instance address is known, so the message can carry a link back. */
  hasLink: z.boolean(),
  lastSentAt: z.string().nullable(),
  lastResult: NTFY_RESULTS.nullable(),
  lastFailure: PushFailure.nullable(),
  createdAt: z.string(),
});
export type NtfyChannelView = z.infer<typeof NtfyChannelView>;
export const NtfyOverview = z.object({ available: z.boolean(), channel: NtfyChannelView.nullable() });
export type NtfyOverview = z.infer<typeof NtfyOverview>;
export const SaveNtfyChannelRequest = z.object({
  server: z.string().max(253).default(DEFAULT_NTFY_SERVER),
  enabled: z.boolean().default(true),
});
export type SaveNtfyChannelRequest = z.infer<typeof SaveNtfyChannelRequest>;

const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];
/**
 * A self-hosted ntfy server is reached over https at a public DNS name: no address literal, port, credentials,
 * path or internal-looking name. The connection check against private addresses is in the sender.
 */
export function ntfyServerOf(value: string): string | null {
  const url = plainHttpsUrl(value.trim());
  if (!url || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  const labels = url.hostname.split('.');
  const top = labels[labels.length - 1]!;
  if (labels.length < 2 || labels.some((label) => !label) || !/[a-z]/.test(top)) return null;
  if (INTERNAL_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))) return null;
  return `https://${url.hostname}`;
}
/** The address a page was loaded from, as the browser's `Origin` header names it (http or https only). */
export function instanceOriginOf(value: string | undefined): string | null {
  if (!value || value.length > 200) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value ? value : null;
  } catch {
    return null;
  }
}
