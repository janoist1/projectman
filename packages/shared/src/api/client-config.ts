import { z } from 'zod';

/**
 * What the `projectman` command-line client (scripts/projectman, PM-765) reads from its own files. The files
 * hold paths and header names only; the secrets stay in the files they name, which the client reads itself.
 */

/** The default place of the client configuration, below the user's home. */
export const CLIENT_CONFIG_RELATIVE_PATH = '.config/projectman/client.json';

/** `~/.config/projectman/client.json`: `{ version: 1, baseUrl, keyFile, accessHeadersFile? }`. */
export const ClientConfig = z.strictObject({
  version: z.literal(1),
  baseUrl: z.string().min(1).max(2048),
  keyFile: z.string().min(1).max(4096),
  accessHeadersFile: z.string().min(1).max(4096).optional(),
});
export type ClientConfig = z.infer<typeof ClientConfig>;

/** The integrator key text: the secret `pmi_…` the server shows once. */
export const ClientKeyText = z.string().regex(/^pmi_[A-Za-z0-9_-]+$/);

/** The Cloudflare Access service-token file written by `npm run cloud -- edge` (`integrator-access-token.json`). */
export const ClientAccessHeaders = z.looseObject({
  'CF-Access-Client-Id': z.string().min(1).max(512),
  'CF-Access-Client-Secret': z.string().min(1).max(2048),
});
export type ClientAccessHeaders = z.infer<typeof ClientAccessHeaders>;

/** Exit codes of the client: 0 done, 1 the operation failed, 2 wrong usage, 3 authentication or credential files. */
export const CLIENT_EXIT = { ok: 0, failed: 1, usage: 2, auth: 3 } as const;

/** The self-reported, non-secret header of the client's REST requests (see `integratorChannel`). */
export const CLIENT_CHANNEL_HEADER = 'X-Projectman-Client';
export const CLIENT_CHANNEL_VALUE = 'cli';
