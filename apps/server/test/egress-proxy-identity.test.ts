import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EgressAllowance } from '@projectman/shared';
import type { EgressSession } from '../src/domain';
import { createManagedEgressProxy } from '../src/runtime-boundary';
import { parsePasswd } from '../src/runtime-boundary/launcher/accounts';
import { testBoundaryConfig } from '../src/runtime-boundary/test-helpers';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/**
 * The managed egress proxy with the real network gate: the member comes from the socket owner
 * (here a fake socket table) or the bridge socket, the session from its token, and a token of
 * another member's session opens nothing.
 */
const PASSWD = [
  'pmw-dev-1:x:20001:20001::/var/lib/projectman-work/pmw-dev-1:/usr/sbin/nologin',
  'pmw-dev-2:x:20002:20002::/var/lib/projectman-work/pmw-dev-2:/usr/sbin/nologin',
].join('\n');
const accounts = {
  byName: (name: string) => parsePasswd(PASSWD).get(name) ?? null,
  list: () => [...parsePasswd(PASSWD).values()],
};
const basic = (token: string) => `Basic ${Buffer.from(`projectman:${token}`).toString('base64')}`;

describe('the managed egress proxy with the network gate', () => {
  let h: DomainHarness;
  let proxy: ReturnType<typeof createManagedEgressProxy<EgressSession>>;
  let port: number;
  let uid: number | null;
  const tokens = new Map<string, EgressSession>();
  let devSession: EgressSession;

  beforeEach(async () => {
    h = await createDomainHarness({ egress: { base: [{ host: 'registry.npmjs.org', port: 443 }] } });
    await h.domain.tasks.create('AR', { title: 'Docs' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    devSession = { projectKey: 'AR', member: 'dev-1', sessionId: started.session!.id, taskKey: 'AR-1' };
    tokens.set('dev-token-0123456789abcd', devSession);
    uid = 20001;
    proxy = createManagedEgressProxy<EgressSession>({
      config: testBoundaryConfig({ egress: { ...testBoundaryConfig().egress, port: 0 } }),
      logger: h.log.logger,
      accounts,
      peerUid: async () => uid,
      resolveToken: (token) => tokens.get(token) ?? null,
      authorize: (identity, destination) => h.domain.egress.authorize(identity, destination),
    });
    await proxy.listen();
    port = (proxy.address() as net.AddressInfo).port;
  });
  afterEach(async () => {
    await proxy.close();
    await h.cleanup();
  });

  function connect(authority: string, token?: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      let data = '';
      socket.setEncoding('latin1');
      socket.on('data', (chunk: string) => {
        data += chunk;
        if (data.includes('\r\n\r\n')) {
          socket.destroy();
          resolve(data.split('\r\n\r\n')[0]!);
        }
      });
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${token ? `Proxy-Authorization: ${basic(token)}\r\n` : ''}\r\n`,
      );
    });
  }

  it('registers a refused destination for the session whose worker connected', async () => {
    const head = await connect('docs.example.org:443', 'dev-token-0123456789abcd');
    expect(head).toContain('X-Projectman-Denial: not_allowed');
    const operation = /X-Projectman-Operation: (egr_\w+)/.exec(head)![1]!;
    expect(h.domain.egress.recentDenials(devSession).map((o) => o.id)).toEqual([operation]);
  });

  it('refuses another member’s session token, and an account that is no worker', async () => {
    uid = 20002; // pmw-dev-2 presents dev-1's token
    expect(await connect('docs.example.org:443', 'dev-token-0123456789abcd')).toContain(
      'X-Projectman-Denial: identity_mismatch',
    );
    expect(h.domain.egress.recentDenials(devSession)).toEqual([]);
    uid = 19000; // the service account
    expect(await connect('registry.npmjs.org:443')).toContain('X-Projectman-Denial: identity_mismatch');
    uid = null; // not in the socket table
    expect(await connect('registry.npmjs.org:443')).toContain('X-Projectman-Denial: identity_mismatch');
  });

  it('takes the member from a bridge socket without asking the socket table', async () => {
    uid = null;
    const handover = net.createServer((socket) => proxy.acceptFrom(socket, 'dev-1'));
    await new Promise<void>((resolve) => handover.listen(0, '127.0.0.1', resolve));
    const bridgePort = (handover.address() as net.AddressInfo).port;
    try {
      const head = await new Promise<string>((resolve) => {
        const socket = net.connect(bridgePort, '127.0.0.1');
        let data = '';
        socket.setEncoding('latin1');
        socket.on('data', (chunk: string) => {
          data += chunk;
          if (data.includes('\r\n\r\n')) {
            socket.destroy();
            resolve(data);
          }
        });
        socket.write(
          `CONNECT docs.example.org:443 HTTP/1.1\r\nProxy-Authorization: ${basic('dev-token-0123456789abcd')}\r\n\r\n`,
        );
      });
      expect(head).toContain('X-Projectman-Denial: not_allowed');
    } finally {
      handover.close();
    }
  });
});

describe('the network gate’s events', () => {
  let h: DomainHarness;
  afterEach(() => h.cleanup());

  it('announces a revoked allowance and a member who may no longer work', async () => {
    h = await createDomainHarness({ egress: { base: [] } });
    const revoked: EgressAllowance[] = [];
    const inactive: Array<{ projectKey: string; member: string }> = [];
    h.domain.ctx.events.on('egress_allowance_revoked', (a) => void revoked.push(a));
    h.domain.ctx.events.on('egress_member_inactive', (m) => void inactive.push(m));
    await h.domain.tasks.create('AR', { title: 'Docs' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    const session = { projectKey: 'AR', member: 'dev-1', sessionId: started.session!.id, taskKey: 'AR-1' };
    const docs = { host: 'docs.example.org', port: 443 };
    const refused = (await h.domain.egress.authorize({ member: 'dev-1', session }, docs)) as {
      operationId: string;
    };
    const request = await h.domain.teamTools.submitBoundaryRequest(session, {
      operationId: refused.operationId,
      deduplicationKey: 'docs',
    });
    await h.domain.boundary.decide('AR', request.id, 'owner', {
      decision: 'allow',
      reason: 'scope_verified',
    });
    const opened = await h.domain.egress.authorize({ member: 'dev-1', session }, docs);
    expect(opened).toMatchObject({ allowed: true, via: 'allowance' });
    await h.domain.egress.revokeAllowance('AR', (opened as { allowanceId: string }).allowanceId, 'owner');
    expect(revoked.map((a) => a.id)).toEqual([(opened as { allowanceId: string }).allowanceId]);

    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      const dev = draft.team.members.find((m) => m.handle === 'dev-1')!;
      if (dev.kind === 'ai') dev.onLeave = true;
      return 'Send dev-1 on leave';
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(inactive).toEqual([{ projectKey: 'AR', member: 'dev-1' }]);
  });
});
