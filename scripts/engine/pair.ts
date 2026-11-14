import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  CLIENT_CONFIG_RELATIVE_PATH,
  EnginePairingStatus,
  formatPairingCode,
  normalizePairingCode,
  PAIRING_TTL_MS,
  routes,
  StartEnginePairingResponse,
} from '@projectman/shared';
import type { StartEnginePairingRequest } from '@projectman/shared';
import {
  cloudOrigin,
  EngineConfigError,
  engineFiles,
  httpUrl,
  readLinkHeaders,
  readSecretFile,
  writeSecretFile,
} from '../../apps/server/src/engine-link/engine-config';
import { ClientConfigError, parseBaseUrl } from '../projectman/config';
import {
  clientKeyFile,
  prepareClientCredentials,
  readAccessHeadersText,
  writeClientCredentials,
} from '../projectman/connect';
import { ClientFileError } from '../projectman/files';
import type { EngineCliIo } from './commands';
import { absoluteFile, buildEngineConfig, previousEngineConfig, UsageError, writeEngineSetup } from './setup';

/**
 * `pair start | wait | cancel` (PM-1449, plan PM-1437 §6): device pairing instead of copying two keys. The machine
 * makes the machine key and the integrator key itself and sends the hub only their SHA-256 hashes and display
 * prefixes. Once the owner approves the printed code on the web, `pair wait` writes what `init` and
 * `projectman connect` write. The keys live only in files (the pending file, then the key files): never in an
 * argument, the environment or the output.
 *
 * Exit status of `pair wait`: 0 written; 1 ended with nothing written (or refused); 3 still pending; 4 approved,
 * but a file is in the way (the pending pairing stays); 2 wrong usage.
 */

const EXIT_ENDED = 1;
const EXIT_PENDING = 3;
const EXIT_CONFLICT = 4;

const WAIT_DEFAULT_SECONDS = 30;
const WAIT_MAX_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 30_000;

/** The shapes the hub checks (`engine-pairing.ts`): 32 random bytes in base64url after the type prefix. */
const MACHINE_KEY = /^pme_[A-Za-z0-9_-]{43}$/;
const INTEGRATOR_KEY = /^pmi_[A-Za-z0-9_-]{43}$/;

const newKey = (prefix: 'pme_' | 'pmi_'): string => `${prefix}${randomBytes(32).toString('base64url')}`;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** `<engine home>/pairing-pending.json` (mode 0600): what `pair wait` needs after `pair start` has exited. */
const PendingPairing = z.strictObject({
  version: z.literal(1),
  cloud: z.string().min(1),
  /** Goes into the request path, so only the hub's id characters. */
  pairingId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  expiresAt: z.string(),
  pollIntervalSeconds: z.number().int().min(1).max(60),
  machineKey: z.string().regex(MACHINE_KEY),
  integratorKey: z.string().regex(INTEGRATOR_KEY),
  name: z.string().min(1).max(64),
  linkHeadersFile: z.string().optional(),
  integratorBaseUrl: z.string().min(1),
  integratorAccessHeadersFile: z.string().optional(),
  expectEmail: z.string().optional(),
  force: z.boolean(),
  replace: z.boolean(),
});
type PendingPairing = z.infer<typeof PendingPairing>;

interface PairContext {
  home: string;
  pendingFile: string;
  userHome: string;
  io: EngineCliIo;
  now: () => number;
}

const SUBCOMMANDS = 'pair start, pair wait or pair cancel';

const START_FLAGS = [
  'cloud',
  'name',
  'link-headers-file',
  'integrator-base-url',
  'integrator-access-headers-file',
  'expect-email',
  'force',
  'replace',
];

export async function runPair(
  sub: string | undefined,
  rest: string[],
  flags: Map<string, string>,
  home: string,
  io: EngineCliIo,
): Promise<number> {
  if (rest.length > 0) throw new UsageError(SUBCOMMANDS);
  const ctx: PairContext = {
    home,
    pendingFile: engineFiles(home).pairingPending,
    userHome: io.userHome ?? homedir(),
    io,
    now: io.now ?? Date.now,
  };
  switch (sub) {
    case 'start':
      onlyFlags(flags, sub, START_FLAGS);
      return start(ctx, flags);
    case 'wait':
      onlyFlags(flags, sub, ['timeout', 'force', 'replace']);
      return wait(ctx, flags);
    case 'cancel':
      onlyFlags(flags, sub, []);
      return cancel(ctx);
    default:
      throw new UsageError(SUBCOMMANDS);
  }
}

function onlyFlags(flags: Map<string, string>, sub: string, allowed: string[]): void {
  for (const name of flags.keys())
    if (name !== 'home' && !allowed.includes(name))
      throw new UsageError(`--${name} is not an option of pair ${sub}`);
}

/** Text from the hub shown in the terminal: no control characters, so it cannot move the cursor or recolour. */
const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

function integratorOrigin(text: string): string {
  try {
    return parseBaseUrl(text).origin;
  } catch (error) {
    if (error instanceof ClientConfigError) throw new UsageError(`--integrator-base-url: ${error.message}`);
    throw error;
  }
}

function pendingExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function readPending(file: string): PendingPairing {
  if (!pendingExists(file))
    throw new EngineConfigError(
      'pairing_missing',
      'No pairing is pending here. Start one with "pair start".',
    );
  let json: unknown;
  try {
    json = JSON.parse(readSecretFile(file, 'pending pairing'));
  } catch (error) {
    if (error instanceof EngineConfigError) throw error;
    json = null;
  }
  const parsed = PendingPairing.safeParse(json);
  if (!parsed.success)
    throw new EngineConfigError(
      'pairing_invalid',
      `${file} is not a pending pairing of this version. Remove it and run "pair start" again.`,
    );
  return parsed.data;
}

function removePending(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

interface HubAnswer {
  status: number;
  json: unknown;
  retryAfter: string | null;
}

/**
 * One request to the hub's `/engine/pairings` door, behind the access layer's engine audience: the link headers go
 * with it. A redirect is not followed (the access layer's login page, or a machine key sent elsewhere).
 */
async function hubRequest(
  ctx: PairContext,
  target: { cloud: string; linkHeadersFile?: string | undefined },
  method: 'POST' | 'GET' | 'DELETE',
  urlPath: string,
  options: { body?: StartEnginePairingRequest; machineKey?: string } = {},
): Promise<HubAnswer> {
  const headers: Record<string, string> = target.linkHeadersFile
    ? readLinkHeaders(target.linkHeadersFile)
    : {};
  if (options.body) headers['content-type'] = 'application/json';
  if (options.machineKey) headers.authorization = `Bearer ${options.machineKey}`;
  const fetchHub = ctx.io.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchHub(httpUrl(target.cloud, urlPath), {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (error) {
    throw new EngineConfigError(
      'hub_unreachable',
      `The hub at ${cloudOrigin(target.cloud).origin} cannot be reached (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const text = await response.text().catch(() => '');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, retryAfter: response.headers.get('retry-after') };
}

/** A hub answer this command does not expect, with the hub's error code when it sent one. */
function hubFailure(answer: HubAnswer): EngineConfigError {
  if (answer.status >= 300 && answer.status < 400)
    return new EngineConfigError(
      'hub_access_refused',
      `The hub's access layer redirected the request (HTTP ${answer.status}); check the link headers file.`,
    );
  const error = (answer.json as { error?: { code?: unknown } } | null)?.error;
  const code = typeof error?.code === 'string' ? printable(error.code) : null;
  return new EngineConfigError(
    'hub_error',
    `The hub answered HTTP ${answer.status}${code ? ` (${code})` : ''}.`,
  );
}

async function start(ctx: PairContext, flags: Map<string, string>): Promise<number> {
  const { io } = ctx;
  const cloud = flags.get('cloud');
  const name = flags.get('name')?.trim();
  const baseUrlText = flags.get('integrator-base-url');
  if (!cloud || !name || !baseUrlText)
    throw new UsageError('pair start needs --cloud, --name and --integrator-base-url');
  if (name.length > 64) throw new UsageError('--name is at most 64 characters');
  const expectEmail = flags.get('expect-email')?.trim();
  if (expectEmail !== undefined && !/^[^\s@]+@[^\s@]+$/.test(expectEmail))
    throw new UsageError('--expect-email is not an e-mail address');
  const origin = cloudOrigin(cloud).origin; // https:// (http:// only for a loopback host)
  const integratorBaseUrl = integratorOrigin(baseUrlText);
  const force = flags.has('force');
  const replace = flags.has('replace');

  // Everything that would make the approval useless is checked before the hub is asked, so no code is shown for
  // a pairing that could not be written.
  if (pendingExists(ctx.pendingFile))
    throw new EngineConfigError(
      'pairing_in_progress',
      'A pairing is already pending here. Run "pair wait" to finish it, or "pair cancel" to withdraw it.',
    );
  const previous = previousEngineConfig(ctx.home, force);
  const headersFlag = flags.get('link-headers-file');
  const linkHeadersFile = headersFlag
    ? absoluteFile(headersFlag, io.cwd, 'The link headers file')
    : previous?.linkHeadersFile;
  const accessFlag = flags.get('integrator-access-headers-file');
  const integratorAccessHeadersFile = accessFlag ? path.resolve(io.cwd, accessFlag) : undefined;
  const accessText = integratorAccessHeadersFile
    ? readAccessHeadersText(integratorAccessHeadersFile)
    : undefined;
  const machineKey = newKey('pme_');
  const integratorKey = newKey('pmi_');
  prepareClientCredentials(
    {
      home: ctx.userHome,
      origin: integratorBaseUrl,
      key: integratorKey,
      ...(accessText === undefined ? {} : { accessText }),
    },
    replace,
  );

  const answer = await hubRequest(ctx, { cloud, linkHeadersFile }, 'POST', routes.enginePairings(), {
    body: {
      name,
      machineKey: { hash: sha256(machineKey), prefix: machineKey.slice(0, 10) },
      integratorKey: { hash: sha256(integratorKey), prefix: integratorKey.slice(0, 12) },
    },
  });
  if (answer.status === 404)
    throw new EngineConfigError(
      'pairing_unavailable',
      'This hub does not offer device pairing. Use the copy steps instead (INSTALL.md).',
    );
  if (answer.status === 429)
    throw new EngineConfigError(
      'too_many_attempts',
      `The hub refuses more pairing requests for now${answer.retryAfter && /^\d+$/.test(answer.retryAfter) ? `; try again in ${answer.retryAfter} seconds` : ''}.`,
    );
  if (answer.status !== 200 && answer.status !== 201) throw hubFailure(answer);
  const started = StartEnginePairingResponse.safeParse(answer.json);
  const code = started.success ? normalizePairingCode(started.data.code) : null;
  if (!started.success || code === null)
    throw new EngineConfigError(
      'hub_error',
      'The hub answered the pairing request with something unexpected.',
    );

  const pending = PendingPairing.safeParse({
    version: 1,
    cloud,
    pairingId: started.data.id,
    expiresAt: started.data.expiresAt,
    pollIntervalSeconds: started.data.pollIntervalSeconds,
    machineKey,
    integratorKey,
    name,
    ...(linkHeadersFile ? { linkHeadersFile } : {}),
    integratorBaseUrl,
    ...(integratorAccessHeadersFile ? { integratorAccessHeadersFile } : {}),
    ...(expectEmail ? { expectEmail } : {}),
    force,
    replace,
  });
  if (!pending.success)
    throw new EngineConfigError(
      'hub_error',
      'The hub answered the pairing request with something unexpected.',
    );
  writeSecretFile(ctx.pendingFile, `${JSON.stringify(pending.data, null, 2)}\n`);

  const shown = formatPairingCode(code);
  io.out(`Pairing requested for "${name}". Open this link, sign in and approve the code:`);
  io.out(`  ${origin}/pair/${shown}`);
  io.out(`Or open ${origin}/pair and type the code:`);
  io.out(`  ${shown}`);
  io.out(
    `The code is valid for ${PAIRING_TTL_MS / 60_000} minutes (until ${printable(started.data.expiresAt)}).`,
  );
  io.out('next: run "pair wait" (again while it exits 3); "pair cancel" withdraws the request');
  return 0;
}

function waitSeconds(flags: Map<string, string>): number {
  const text = flags.get('timeout');
  if (text === undefined) return WAIT_DEFAULT_SECONDS;
  const seconds = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!(seconds >= 1 && seconds <= WAIT_MAX_SECONDS))
    throw new UsageError(`--timeout is a whole number of seconds from 1 to ${WAIT_MAX_SECONDS}`);
  return seconds;
}

const ENDED: Record<'denied' | 'expired' | 'cancelled' | 'unknown', string> = {
  denied:
    'The pairing was denied on the web. Nothing was written. Ask the friend whether they started it; request a new code only if they want to.',
  expired:
    'The code expired before it was approved. Nothing was written. Request a new code with "pair start".',
  cancelled: 'The pairing was cancelled. Nothing was written.',
  unknown: 'The hub no longer knows this pairing. Nothing was written. Request a new code with "pair start".',
};

function ended(ctx: PairContext, reason: keyof typeof ENDED): number {
  removePending(ctx.pendingFile);
  ctx.io.err(`PAIRING ENDED [${reason}]: ${ENDED[reason]}`);
  return EXIT_ENDED;
}

async function wait(ctx: PairContext, flags: Map<string, string>): Promise<number> {
  const seconds = waitSeconds(flags);
  const pending = readPending(ctx.pendingFile);
  const sleep = ctx.io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = pending.pollIntervalSeconds * 1000;
  const deadline = ctx.now() + seconds * 1000;
  for (;;) {
    const answer = await hubRequest(ctx, pending, 'GET', routes.enginePairing(pending.pairingId), {
      machineKey: pending.machineKey,
    });
    if (answer.status === 404) return ended(ctx, 'unknown');
    if (answer.status !== 200) throw hubFailure(answer);
    const status = EnginePairingStatus.safeParse(answer.json);
    if (!status.success)
      throw new EngineConfigError('hub_error', 'The hub answered the poll with something unexpected.');
    const state = status.data;
    if (state.state === 'approved') return finish(ctx, flags, pending, state);
    if (state.state !== 'pending') return ended(ctx, state.state);
    if (ctx.now() + interval > deadline) {
      ctx.io.out(
        `Still waiting for the approval (the code is valid until ${printable(state.expiresAt)}). Run "pair wait" again.`,
      );
      return EXIT_PENDING;
    }
    await sleep(interval);
  }
}

type Approved = Extract<EnginePairingStatus, { state: 'approved' }>;

/** The two codes a `--force` / `--replace` resolves; any other refusal stays a refusal. */
const CONFLICTS = new Set(['config_exists', 'connect_file_exists']);

function finish(
  ctx: PairContext,
  flags: Map<string, string>,
  pending: PendingPairing,
  approved: Approved,
): number {
  const { io } = ctx;
  const approver = `${printable(approved.approvedBy.name)} <${printable(approved.approvedBy.email)}>`;
  if (
    pending.expectEmail !== undefined &&
    approved.approvedBy.email.trim().toLowerCase() !== pending.expectEmail.toLowerCase()
  ) {
    removePending(ctx.pendingFile);
    io.err(
      `PAIRING ENDED [approver_mismatch]: approved by ${approver}, not by ${pending.expectEmail}. Nothing was written. The engine "${printable(approved.engineName)}" (${printable(approved.engineId)}) and its key were made in that account; ask its owner to remove them in Settings.`,
    );
    return EXIT_ENDED;
  }
  const force = pending.force || flags.has('force');
  const replace = pending.replace || flags.has('replace');
  let prepared;
  try {
    // Checked again: a file may have appeared since `pair start`.
    const previous = previousEngineConfig(ctx.home, force);
    const config = buildEngineConfig(previous, {
      cloud: pending.cloud,
      id: approved.engineId,
      name: approved.engineName,
      ...(pending.linkHeadersFile ? { linkHeadersFile: pending.linkHeadersFile } : {}),
    });
    const accessText = pending.integratorAccessHeadersFile
      ? readAccessHeadersText(pending.integratorAccessHeadersFile)
      : undefined;
    const client = prepareClientCredentials(
      {
        home: ctx.userHome,
        origin: pending.integratorBaseUrl,
        key: pending.integratorKey,
        ...(accessText === undefined ? {} : { accessText }),
      },
      replace,
    );
    prepared = { config, client };
  } catch (error) {
    if (
      (error instanceof EngineConfigError || error instanceof ClientFileError) &&
      CONFLICTS.has(error.code)
    ) {
      io.err(
        `PAIRING APPROVED BUT NOT WRITTEN [${error.code}]: ${error.message} The approval by ${approver} stays pending here: run "pair wait --force" (engine configuration) or "pair wait --replace" (client files) only after the friend says yes to replacing them.`,
      );
      return EXIT_CONFLICT;
    }
    io.err(
      `The approved pairing stays pending here: fix the cause below and run "pair wait" again, or "pair cancel".`,
    );
    throw error;
  }

  const files = engineFiles(ctx.home);
  const keyFile = writeEngineSetup(ctx.home, prepared.config, pending.machineKey);
  writeClientCredentials(prepared.client);
  removePending(ctx.pendingFile);
  io.out(`Approved by ${approver}.`);
  io.out(
    `engine "${prepared.config.name ?? ''}" (${prepared.config.engineId}) configured at ${files.config}; the machine key is in ${keyFile} (mode 0600)`,
  );
  io.out(
    `the client key is in ${clientKeyFile(ctx.userHome)} (mode 0600, valid until ${printable(approved.integratorKeyExpiresAt)}); the client configuration is ${path.join(ctx.userHome, CLIENT_CONFIG_RELATIVE_PATH)}`,
  );
  io.out(
    'next: bind the project with "project set <KEY> <path>" (INSTALL.md, "Connecting the engine to the hub"), then register the MCP server (INSTALL.md, "The connected AI")',
  );
  return 0;
}

async function cancel(ctx: PairContext): Promise<number> {
  const pending = readPending(ctx.pendingFile);
  const answer = await hubRequest(ctx, pending, 'DELETE', routes.enginePairing(pending.pairingId), {
    machineKey: pending.machineKey,
  });
  // 404: the hub has forgotten it already; either way nothing of it is left here.
  if (answer.status !== 204 && answer.status !== 200 && answer.status !== 404) throw hubFailure(answer);
  removePending(ctx.pendingFile);
  ctx.io.out('The pairing request is withdrawn. Nothing was written.');
  return 0;
}
