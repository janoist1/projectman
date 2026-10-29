import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS, runCloud } from '../../../scripts/cloud/commands';
import type { CloudDeps } from '../../../scripts/cloud/deps';
import { CloudError } from '../../../scripts/cloud/errors';
import { CloudflareWorld } from './helpers/fake-cloudflare';

let world: CloudflareWorld;
let awsCalls: string[][];
let ds: string[];
let autoRenew: boolean;
let dnssecKeys: unknown[];
const dependencies = (): CloudDeps => {
  const original = world.deps();
  return world.deps({
    run: async (command, args, options) => {
      if (command !== 'aws' || args[6] !== 'route53domains') return original.run(command, args, options);
      awsCalls.push(args);
      if (args[7] !== 'get-domain-detail') throw new Error(`unexpected AWS operation ${args[7]}`);
      const value = {
        AutoRenew: autoRenew,
        ExpirationDate: 1795046400,
        Nameservers: [{ Name: 'old.aws.test' }],
        DnssecKeys: dnssecKeys,
      };
      return { code: 0, stdout: JSON.stringify(value), stderr: '' };
    },
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.cloudflare.com') return world.cf.fetch(input, init);
      return Response.json({
        Status: 0,
        Answer: (url.searchParams.get('type') === 'DS'
          ? ds
          : ['ada.ns.cloudflare.com.', 'bob.ns.cloudflare.com.']
        ).map((data) => ({ type: url.searchParams.get('type') === 'DS' ? 43 : 2, data })),
      });
    }) as typeof fetch,
  });
};
const run = (...args: string[]) => runCloud(['dns', ...args], dependencies());
beforeEach(() => {
  world = CloudflareWorld.ready();
  world.writeToken();
  world.cf.addZone('example.com');
  awsCalls = [];
  ds = [];
  autoRenew = true;
  dnssecKeys = [];
});
afterEach(() => world.cleanup());

describe('dns status', () => {
  it('reads the registrar with the registrar profile in us-east-1 and never changes it', async () => {
    world.writeConfig({ route53: { profile: 'i' } });
    expect(await run('status')).toBe(0);
    expect(awsCalls.length).toBeGreaterThan(0);
    expect(awsCalls.every((call) => call.slice(0, 4).join(' ') === '--profile i --region us-east-1')).toBe(
      true,
    );
    expect(awsCalls.every((call) => call[7] === 'get-domain-detail')).toBe(true);
  });

  it('shows public delegation, DNSSEC, auto-renew, and requests activation', async () => {
    world.writeConfig({ route53: { profile: 'i' } });
    world.cf.zones[0]!.status = 'pending';
    ds = ['123 13 2 digest'];
    autoRenew = false;
    expect(await run('status')).toBe(0);
    expect(world.output).toContain('WARN DNSSEC');
    expect(world.output).toContain('WARN enable domain auto-renew');
    expect(awsCalls[0]!.slice(0, 4)).toEqual(['--profile', 'i', '--region', 'us-east-1']);
    expect(world.cf.mutations().map((call) => call.method)).toEqual(['PUT']);
  });

  it('keeps no retired migration command', async () => {
    for (const retired of ['plan', 'import', 'verify', 'switch'])
      expect(COMMANDS[`dns ${retired}`]).toBeUndefined();
    expect(await run('plan')).toBe(64);
  });
});

describe('up orchestration', () => {
  it('previews a new pending zone without publishing or running check', async () => {
    world.cf.zones.length = 0;
    const names = ['preflight', 'aws', 'edge', 'deploy', 'publish', 'check'];
    const originals = names.map((name) => COMMANDS[name]!.run),
      calls: string[] = [];
    names.forEach((name) => {
      COMMANDS[name]!.run = async (_context, invocation) => {
        expect(invocation.dryRun).toBe(true);
        calls.push(name);
      };
    });
    try {
      expect(await runCloud(['up', '--dry-run', '--login-json', 'login.json'], dependencies())).toBe(0);
      expect(calls).toEqual(names.slice(0, 4));
      expect(world.cf.mutations()).toEqual([]);
    } finally {
      names.forEach((name, index) => {
        COMMANDS[name]!.run = originals[index]!;
      });
    }
  });
  it.each([false, true])('runs in order and checks only with a login file (%s)', async (login) => {
    const names = ['preflight', 'aws', 'edge', 'deploy', 'publish', 'check'];
    const originals = names.map((name) => COMMANDS[name]!.run),
      calls: string[] = [];
    for (const name of names)
      COMMANDS[name]!.run = async () => {
        calls.push(name);
      };
    try {
      expect(await runCloud(['up', ...(login ? ['--login-json', 'login.json'] : [])], dependencies())).toBe(
        0,
      );
      expect(calls).toEqual(login ? names : names.slice(0, -1));
    } finally {
      names.forEach((name, index) => {
        COMMANDS[name]!.run = originals[index]!;
      });
    }
  });
  it('stops at the first error and preserves its exit code', async () => {
    const original = COMMANDS.preflight!.run;
    COMMANDS.preflight!.run = async () => {
      throw new CloudError('stop', 2);
    };
    try {
      expect(await runCloud(['up'], dependencies())).toBe(2);
      expect(world.cf.calls).toEqual([]);
    } finally {
      COMMANDS.preflight!.run = original;
    }
  });
  it('stops before publishing a pending zone', async () => {
    world.cf.zones[0]!.status = 'pending';
    const names = ['preflight', 'aws', 'edge', 'deploy', 'publish'];
    const originals = names.map((name) => COMMANDS[name]!.run),
      calls: string[] = [];
    names.forEach((name) => {
      COMMANDS[name]!.run = async () => {
        calls.push(name);
      };
    });
    try {
      expect(await runCloud(['up'], dependencies())).toBe(0);
      expect(calls).toEqual(names.slice(0, -1));
      expect(world.output).toContain('dns status until active');
    } finally {
      names.forEach((name, index) => {
        COMMANDS[name]!.run = originals[index]!;
      });
    }
  });
});
