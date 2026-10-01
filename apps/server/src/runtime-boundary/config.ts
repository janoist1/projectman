import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { EgressDestination, EGRESS_MAX_GRANT_HOURS } from '@projectman/shared';
import type { WorkerLayout } from '../contracts';

/**
 * The boundary configuration of the managed VM profile (PM-140): one root-owned JSON file
 * (`/etc/projectman/boundary.json`, written by deploy/vm/bootstrap.sh from profile.env) read by
 * the server and by the root launcher. It holds paths, uids, ports and destinations, never a
 * secret. The schema is strict: an unknown key or a wrong value stops the server at startup.
 */

const AbsolutePath = z
  .string()
  .min(2)
  .max(512)
  .refine((p) => path.posix.isAbsolute(p) && path.posix.normalize(p) === p && !p.endsWith('/'), {
    message: 'must be an absolute, normalized path',
  });

export const BoundaryConfig = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal('managed-vm'),
  /** The VM profile version the readiness report must be for. */
  profileVersion: z.number().int().min(1),
  /** The account the server runs as. */
  serviceUser: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
  launcher: z.strictObject({
    /** The launcher's socket: root-owned, group = the service's group, mode 0660 (socket unit). */
    socket: AbsolutePath,
    maxSessions: z.number().int().min(1).max(256),
  }),
  workers: z.strictObject({
    /** Worker account names are `<prefix><handle>`. */
    prefix: z.string().regex(/^[a-z][a-z0-9]{0,7}-$/),
    homeRoot: AbsolutePath,
    uidMin: z.number().int().min(1000),
    uidMax: z.number().int().max(60_000),
    /** `<spoolRoot>/<handle>/{in,out}`: bundles between the service and the worker. */
    spoolRoot: AbsolutePath,
  }),
  /** The pinned programs a worker may be started with. */
  programs: z.strictObject({
    git: AbsolutePath,
    mkdir: AbsolutePath,
    rm: AbsolutePath,
    mv: AbsolutePath,
    claude: AbsolutePath,
    codex: AbsolutePath,
    node: AbsolutePath,
  }),
  /** The deployed app (root-owned); the launcher runs its claude-trust helper from there. */
  appDir: AbsolutePath,
  systemdRun: AbsolutePath,
  systemctl: AbsolutePath,
  /** PATH of worker processes. */
  workerPath: z.string().regex(/^\/[^:\s]*(?::\/[^:\s]*)*$/),
  egress: z.strictObject({
    host: z.literal('127.0.0.1'),
    port: z.number().int().min(1024).max(65_535),
    grantHours: z.number().int().min(1).max(EGRESS_MAX_GRANT_HOURS),
    /** Destinations every worker may reach: the subscription CLIs, npm and GitHub. */
    base: z.array(EgressDestination).max(200),
  }),
  readiness: z.strictObject({
    report: AbsolutePath,
    maxAgeSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400),
  }),
  /** The app's loopback port (hooks and MCP), the only service port a worker needs. */
  appPort: z.number().int().min(1).max(65_535),
});
export type BoundaryConfig = z.infer<typeof BoundaryConfig>;

/** Reads and validates the boundary configuration; throws with the path on any problem. */
export function loadBoundaryConfig(file: string): BoundaryConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read the boundary configuration ${file}: ${(err as Error).message}`);
  }
  const parsed = BoundaryConfig.safeParse(raw);
  if (!parsed.success)
    throw new Error(`invalid boundary configuration ${file}: ${z.prettifyError(parsed.error)}`);
  if (parsed.data.workers.uidMin > parsed.data.workers.uidMax)
    throw new Error(`invalid boundary configuration ${file}: workers.uidMin > workers.uidMax`);
  return parsed.data;
}

export const MEMBER_HANDLE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;

/** A worker's home: `<homeRoot>/<account name>`, as bootstrap.sh creates it (`pmw-<handle>`). */
export function workerHome(config: BoundaryConfig, member: string): string {
  if (!MEMBER_HANDLE.test(member)) throw new Error(`invalid member handle: ${member}`);
  return path.posix.join(config.workers.homeRoot, `${config.workers.prefix}${member}`);
}

/** The member whose worker home holds `target`, or null. */
export function memberOfPath(config: BoundaryConfig, target: string): string | null {
  const resolved = path.posix.resolve(target);
  const { homeRoot, prefix } = config.workers;
  if (!resolved.startsWith(`${homeRoot}/`)) return null;
  const account = resolved.slice(homeRoot.length + 1).split('/')[0]!;
  const member = account.startsWith(prefix) ? account.slice(prefix.length) : '';
  return MEMBER_HANDLE.test(member) ? member : null;
}

/** Worker paths from the configuration (`WorkerLayout`). */
export function workerLayout(config: BoundaryConfig): WorkerLayout {
  const handle = (member: string) => {
    if (!MEMBER_HANDLE.test(member)) throw new Error(`invalid member handle: ${member}`);
    return member;
  };
  const home = (member: string) => workerHome(config, member);
  return {
    home,
    workspaces: (member) => path.posix.join(home(member), 'workspaces'),
    sessions: (member, projectKey) => {
      if (!PROJECT_KEY.test(projectKey)) throw new Error(`invalid project key: ${projectKey}`);
      return path.posix.join(home(member), 'sessions', projectKey);
    },
    spoolIn: (member) => path.posix.join(config.workers.spoolRoot, handle(member), 'in'),
    spoolOut: (member) => path.posix.join(config.workers.spoolRoot, handle(member), 'out'),
  };
}

/** Whether `child` equals `parent` or lies below it (absolute POSIX paths, compared as text). */
export function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}
