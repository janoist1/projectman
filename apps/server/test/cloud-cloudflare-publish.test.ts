import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { CloudflareWorld } from './helpers/fake-cloudflare';
import { SHA_NEW } from './helpers/fake-host';

/** `npm run cloud -- publish` (PM-536): the DNS record comes last, after every check. */

let world: CloudflareWorld;

const FEEDBACK = { zone: 'example.com', hostname: 'board.example.com', feedbackHostname: 'mark.example.com' };

const edge = () => runCloud(['edge'], world.deps());
const publish = (...args: string[]) => runCloud(['publish', ...args], world.deps());
const dnsMutations = () => world.cf.mutations().filter((call) => /dns_records/.test(call.path));

/** An account where `edge` ran, the zone is active and the tunnel is connected. */
async function published(config?: Record<string, unknown>): Promise<void> {
  if (config) world.writeConfig(config);
  expect(await edge()).toBe(0);
  world.cf.zones[0]!.status = 'active';
  world.cf.tunnels[0]!.status = 'healthy';
  world.machine.preload(SHA_NEW, 'v2026.10.12');
  world.lines.length = 0;
  world.cf.calls.length = 0;
}

beforeEach(() => {
  world = CloudflareWorld.ready();
  world.writeToken();
});
afterEach(() => world.cleanup());

describe('publish', () => {
  it('makes one proxied CNAME to the tunnel and changes nothing the second time', async () => {
    await published();
    expect(await publish()).toBe(0);
    const tunnel = world.cf.tunnels[0]!;
    expect(dnsMutations().map((call) => call.body)).toEqual([
      {
        type: 'CNAME',
        name: 'board.example.com',
        content: `${tunnel.id}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
      },
    ]);
    expect(world.output).toContain('created dns board.example.com');
    world.cf.calls.length = 0;
    expect(await publish()).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.output).toContain('unchanged dns board.example.com');
  });

  it('only reads under --dry-run', async () => {
    await published();
    expect(await publish('--dry-run')).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.output).toContain('skipped dns board.example.com: dry-run: would create the proxied CNAME');
  });

  it('makes the proxied flag right on its own CNAME', async () => {
    await published();
    const tunnel = world.cf.tunnels[0]!;
    world.cf.records.push({
      id: 'rec-own',
      zone_id: world.cf.zones[0]!.id,
      type: 'CNAME',
      name: 'board.example.com',
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: false,
    });
    expect(await publish()).toBe(0);
    expect(world.cf.records[0]!.proxied).toBe(true);
    expect(world.output).toContain('updated dns board.example.com');
  });

  it.each([
    ['an A record', { type: 'A', content: '192.0.2.10' }],
    ['a CNAME to somewhere else', { type: 'CNAME', content: 'elsewhere.example.net' }],
  ])('refuses a name that already has %s, and leaves it alone', async (_label, record) => {
    await published();
    world.cf.records.push({
      id: 'rec-x',
      zone_id: world.cf.zones[0]!.id,
      name: 'board.example.com',
      proxied: true,
      ...record,
    });
    expect(await publish()).toBe(2);
    expect(world.output).toContain('FAIL dns board.example.com');
    expect(dnsMutations()).toEqual([]);
    expect(world.cf.records).toHaveLength(1);
  });

  it('refuses a name with several records', async () => {
    await published();
    for (const id of ['r1', 'r2'])
      world.cf.records.push({
        id,
        zone_id: world.cf.zones[0]!.id,
        type: 'TXT',
        name: 'board.example.com',
        content: id,
      });
    expect(await publish()).toBe(2);
    expect(world.output).toContain('2 DNS records');
    expect(dnsMutations()).toEqual([]);
  });
});

describe('what stops publish', () => {
  it('stops while the zone is not active (the DNS has not moved yet)', async () => {
    await published();
    world.cf.zones[0]!.status = 'pending';
    expect(await publish()).toBe(2);
    expect(world.output).toContain('is pending, not active');
    expect(world.output).toContain('move the DNS');
    expect(dnsMutations()).toEqual([]);
  });

  it('stops while the tunnel is not healthy', async () => {
    await published();
    world.cf.tunnels[0]!.status = 'down';
    expect(await publish()).toBe(2);
    expect(world.output).toContain('is down, not healthy');
    expect(dnsMutations()).toEqual([]);
  });

  it('stops when an application has a policy that is not its own', async () => {
    await published();
    const { cf } = world;
    cf.app('projectman-cloud-engine')!.policies.push({
      id: cf.policy('projectman-cloud-allow-emails')!.id,
      precedence: 2,
    });
    expect(await publish()).toBe(2);
    expect(world.output).toContain('projectman-cloud-engine does not have exactly its own policies');
    expect(dnsMutations()).toEqual([]);
  });

  it('stops when the allow policy lets in someone who is not listed', async () => {
    await published();
    const policy = world.cf.policy('projectman-cloud-allow-emails')!;
    policy.include = [...policy.include, { everyone: {} }];
    expect(await publish()).toBe(2);
    expect(world.output).toContain('is not exactly the e-mail list');
    expect(dnsMutations()).toEqual([]);
  });

  it('stops when an application is missing', async () => {
    await published();
    world.cf.apps.length = 0;
    expect(await publish()).toBe(2);
    expect(world.output).toContain('the Access application projectman-cloud does not exist');
    expect(dnsMutations()).toEqual([]);
  });

  it('stops when edge has not run', async () => {
    expect(await publish()).toBe(2);
    expect(world.output).toContain('run "npm run cloud -- edge" first');
    expect(world.cf.mutations()).toEqual([]);
  });
});

/** PM-1065: the further owners' policies are part of what publish verifies. */
describe('publish with further owners', () => {
  const OWNERS = {
    cloudflare: {
      zone: 'example.com',
      hostname: 'board.example.com',
      integratorHostname: 'machine.example.com',
    },
    access: {
      emails: ['owner@example.com'],
      integratorServiceToken: true,
      owners: [{ id: 'alpha', name: 'Alpha Ltd', email: 'alpha@example.com' }],
    },
  };

  it('accepts the access setup when each owner policy is exactly its own token', async () => {
    await published(OWNERS);
    await publish();
    expect(world.output).toContain('ok access: both applications have exactly their own policies');
  });

  it('stops when an owner policy is not exactly its own token', async () => {
    await published(OWNERS);
    const policy = world.cf.policy('projectman-cloud-owner-alpha-engine-service')!;
    policy.include = [...policy.include, { everyone: {} }];
    expect(await publish()).toBe(2);
    expect(world.output).toContain(
      'projectman-cloud-owner-alpha-engine-service is not exactly its service token',
    );
    expect(dnsMutations()).toEqual([]);
  });

  it('stops when an owner policy is missing from the engine application', async () => {
    await published(OWNERS);
    const app = world.cf.app('projectman-cloud-engine')!;
    app.policies = app.policies.slice(0, 1);
    expect(await publish()).toBe(2);
    expect(world.output).toContain('projectman-cloud-engine does not have exactly its own policies');
    expect(dnsMutations()).toEqual([]);
  });
});

describe('publish --feedback', () => {
  it('refuses without a feedback hostname in the configuration', async () => {
    await published();
    expect(await publish('--feedback')).toBe(2);
    expect(world.output).toContain('cloudflare.feedbackHostname');
    expect(dnsMutations()).toEqual([]);
  });

  it('publishes both names when the machine answers 404 twice', async () => {
    await published({ cloudflare: FEEDBACK });
    expect(await publish('--feedback')).toBe(0);
    expect(dnsMutations().map((call) => (call.body as { name: string }).name)).toEqual([
      'board.example.com',
      'mark.example.com',
    ]);
    const guard = world.hostCalls.find((call) => call.subcommand === 'guard-check')!;
    expect(guard.args).toEqual(['mark.example.com']);
  });

  it.each([
    ['plain', { plain: '200', port: '404' }],
    ['with a port', { plain: '404', port: '200' }],
  ])('refuses when the board answers 200 on the %s hostname, and makes no record', async (_label, codes) => {
    await published({ cloudflare: FEEDBACK });
    world.machine.guardCodes = codes;
    expect(await publish('--feedback')).toBe(2);
    expect(world.output).toContain('not 404 twice');
    expect(dnsMutations()).toEqual([]);
  });

  it('refuses when cloud.env does not name the feedback address', async () => {
    await published({ cloudflare: FEEDBACK });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(world.envFile, 'TUNNEL_TOKEN=tunnel-token-value-0123456789\n', { mode: 0o600 });
    expect(await publish('--feedback')).toBe(2);
    expect(world.output).toContain('PROJECTMAN_FEEDBACK_PUBLIC_URL=https://mark.example.com');
    expect(dnsMutations()).toEqual([]);
  });

  it('does not touch the machine without --feedback', async () => {
    await published({ cloudflare: FEEDBACK });
    expect(await publish()).toBe(0);
    expect(world.hostCalls).toEqual([]);
    expect(dnsMutations().map((call) => (call.body as { name: string }).name)).toEqual(['board.example.com']);
  });
});
