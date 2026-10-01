import { realpathSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import type { EgressDestination, RuntimeBoundaryStatus } from '@projectman/shared';
import type { RuntimeBoundary, SessionLauncher, WorkerLayout } from '../contracts';
import type { WorkspaceAccess } from '../worktree';
import type { BoundaryConfig } from './config';
import { MEMBER_HANDLE, memberOfPath, workerHome, workerLayout } from './config';
import { createEgressProxy } from './egress/proxy';
import type { PeerAddress, ProxyDecision, ProxyIdentity } from './egress/proxy';
import { procPeerUid } from './egress/peer';
import { passwdAccounts } from './launcher/accounts';
import type { AccountLookup } from './launcher/daemon';
import { createLauncherClient } from './launcher/client';
import { readinessProblems } from './readiness';
import { workerWorkspaceAccess } from './worker-workspaces';

export { BoundaryConfig, loadBoundaryConfig, workerLayout } from './config';
export { createLauncherClient, LauncherClientError } from './launcher/client';
export { createEgressProxy, denialText, proxyToken } from './egress/proxy';
export { workerWorkspaceAccess } from './worker-workspaces';
export { createServiceBridges } from './bridge/service-bridges';
export type { ServiceBridges } from './bridge/service-bridges';
export { passwdAccounts } from './launcher/accounts';

/**
 * The VM boundary (PM-140): the launcher client, the worker layout, the egress proxy and the
 * readiness verdict, from the root-owned boundary configuration. `disabledRuntimeBoundary()` is
 * the boundary of every other installation: mode `off`, never ready, nothing to launch through.
 */

const STATUS_CACHE_MS = 5_000;

export function disabledRuntimeBoundary(now: () => Date = () => new Date()): RuntimeBoundary {
  return {
    mode: 'off',
    launcher: null,
    layout: null,
    status: async () => ({
      mode: 'off',
      ready: false,
      checkedAt: now().toISOString(),
      problems: ['not_configured'],
      launcher: 'off',
      egress: 'off',
      readiness: null,
    }),
  };
}

export interface ManagedRuntimeBoundary extends RuntimeBoundary {
  readonly mode: 'managed_vm';
  readonly launcher: SessionLauncher;
  readonly layout: WorkerLayout;
  readonly config: BoundaryConfig;
  /** Member workspaces in worker homes, touched only as their workers. */
  readonly workspaceAccess: WorkspaceAccess;
  /** The root of a member's workspaces. */
  workspacesRoot(member: string): string;
}

/**
 * The worker and spool roots must be real paths: whose files a path holds is decided by its text
 * (`memberOfPath`) against resolved workspace paths, so a symlinked root would make a worker's
 * repository look like the server's own. A root that does not exist yet is created by bootstrap.sh
 * as root, where no account of the profile can make it a symlink.
 */
export function assertRealRoots(config: BoundaryConfig): void {
  for (const root of [config.workers.homeRoot, config.workers.spoolRoot]) {
    let real: string;
    try {
      real = realpathSync(root);
    } catch {
      continue;
    }
    if (real !== root) throw new Error(`the boundary path ${root} must not be a symlink (it is ${real})`);
  }
}

/** A boundary built by `createRuntimeBoundary` (not a test's fake). */
export function isManagedBoundary(boundary: RuntimeBoundary): boundary is ManagedRuntimeBoundary {
  return boundary.mode === 'managed_vm' && 'workspaceAccess' in boundary;
}

export function createRuntimeBoundary(opts: {
  config: BoundaryConfig;
  /** Whether the in-process egress proxy is listening. */
  egressUp: () => boolean;
  launcher?: SessionLauncher;
  /** Runs before a member's unit starts: its bridge sockets (`ServiceBridges.ensure`). */
  prepare?: (member: string) => Promise<void>;
  now?: () => Date;
  readReport?: (file: string) => Promise<string>;
}): ManagedRuntimeBoundary {
  const { config } = opts;
  assertRealRoots(config);
  const now = opts.now ?? (() => new Date());
  const client = opts.launcher ?? createLauncherClient({ socketPath: config.launcher.socket });
  const prepare = opts.prepare;
  const launcher: SessionLauncher = prepare
    ? {
        ping: () => client.ping(),
        start: async (request) => {
          await prepare(request.member);
          return client.start(request);
        },
        run: async (request) => {
          await prepare(request.member);
          return client.run(request);
        },
      }
    : client;
  const layout = workerLayout(config);
  let cached: { at: number; status: Promise<RuntimeBoundaryStatus> } | null = null;

  async function measure(): Promise<RuntimeBoundaryStatus> {
    const at = now();
    const [readiness, launcherUp] = await Promise.all([
      readinessProblems({
        file: config.readiness.report,
        profileVersion: config.profileVersion,
        maxAgeMs: config.readiness.maxAgeSeconds * 1000,
        now: at,
        read: opts.readReport,
      }),
      launcher.ping(),
    ]);
    const egressUp = opts.egressUp();
    const problems = [...readiness.problems];
    if (!launcherUp) problems.push('launcher_unreachable');
    if (!egressUp) problems.push('egress_proxy_down');
    return {
      mode: 'managed_vm',
      ready: problems.length === 0,
      checkedAt: at.toISOString(),
      problems,
      launcher: launcherUp ? 'up' : 'down',
      egress: egressUp ? 'up' : 'down',
      readiness: readiness.readiness,
    };
  }

  return {
    mode: 'managed_vm',
    config,
    launcher,
    layout,
    workspaceAccess: workerWorkspaceAccess({
      layout,
      ownerOf: (target) => memberOfPath(config, target),
      launcher,
    }),
    workspacesRoot: (member) => layout.workspaces(member),
    status({ refresh } = {}) {
      const at = Date.now();
      if (!refresh && cached && at - cached.at < STATUS_CACHE_MS) return cached.status;
      const status = measure().catch((): RuntimeBoundaryStatus => ({
        mode: 'managed_vm',
        ready: false,
        checkedAt: now().toISOString(),
        problems: ['readiness_report_invalid'],
        launcher: 'down',
        egress: opts.egressUp() ? 'up' : 'down',
        readiness: null,
      }));
      cached = { at, status };
      return status;
    },
  };
}

/** The proxy tag of a member's tunnels in a project (closed when the member may no longer work). */
export function egressScopeTag(projectKey: string, member: string): string {
  return `scope:${projectKey}:${member}`;
}

/** The worker account (its member) behind a uid, from the account table and the configuration. */
export function workerForUid(config: BoundaryConfig, accounts: AccountLookup, uid: number): string | null {
  if (uid < config.workers.uidMin || uid > config.workers.uidMax) return null;
  for (const candidate of accounts.list()) {
    if (candidate.uid !== uid || !candidate.user.startsWith(config.workers.prefix)) continue;
    const member = candidate.user.slice(config.workers.prefix.length);
    if (MEMBER_HANDLE.test(member) && candidate.home === workerHome(config, member)) return member;
  }
  return null;
}

/**
 * The egress proxy of the managed VM, identifying connections by socket owner (`/proc/net/tcp`)
 * and proxy credentials (the session's egress token), deciding with the network gate.
 */
export function createManagedEgressProxy<S>(opts: {
  config: BoundaryConfig;
  logger: FastifyBaseLogger;
  /** The session an egress token belongs to (SessionOrchestrator), or null. */
  resolveToken(token: string): S | null;
  /** The network gate (EgressService.authorize). */
  authorize(
    identity: { member: string; session: S | null },
    destination: EgressDestination,
  ): Promise<ProxyDecision>;
  accounts?: AccountLookup;
  peerUid?: (
    client: { address: string; port: number },
    server: { address: string; port: number },
  ) => Promise<number | null>;
}) {
  const accounts = opts.accounts ?? passwdAccounts();
  const peerUid = opts.peerUid ?? procPeerUid;
  return createEgressProxy<{ member: string; session: S | null }>({
    host: opts.config.egress.host,
    port: opts.config.egress.port,
    logger: opts.logger,
    // One member cannot take every tunnel of the proxy.
    keyOf: (identity) => identity.member,
    async identify(
      peer: PeerAddress,
      token,
      bridged,
    ): Promise<ProxyIdentity<{ member: string; session: S | null }>> {
      // A session's own bridge socket names its member; a TCP connection on the loopback port (a
      // person's login run as the worker) is known by the socket owner in the kernel's table.
      let member = bridged;
      if (!member) {
        const uid = await peerUid(
          { address: peer.remoteAddress, port: peer.remotePort },
          { address: peer.localAddress, port: peer.localPort },
        );
        member = uid === null ? null : workerForUid(opts.config, accounts, uid);
      }
      if (!member) return { denial: 'identity_mismatch' };
      return { identity: { member, session: token ? opts.resolveToken(token) : null } };
    },
    authorize: (identity, destination) => opts.authorize(identity, destination),
  });
}
