import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS, runCloud } from '../../../scripts/cloud/commands';
import { mapRecords, txtContent } from '../../../scripts/cloud/dns';
import type { CloudDeps } from '../../../scripts/cloud/deps';
import { CloudError } from '../../../scripts/cloud/errors';
import { CloudflareWorld } from './helpers/fake-cloudflare';

const rr = (Type: string, values: string[], Name = 'example.com.', TTL = 300) => ({
  Name,
  Type,
  TTL,
  ResourceRecords: values.map((Value) => ({ Value })),
});
let world: CloudflareWorld;
let sources: Parameters<typeof mapRecords>[0];
let awsCalls: string[][];
let dnsCalls: { name: string; type: string; servers?: string[] }[];
let answers: (name: string, type: string, server: string) => string[];
let ds: string[];
let autoRenew: boolean;
let registeredServers: string[];
let dnssecKeys: unknown[];
const dependencies = (): CloudDeps => {
  const original = world.deps();
  return world.deps({
    run: async (command, args, options) => {
      if (command !== 'aws' || !['route53', 'route53domains'].includes(args[6]!))
        return original.run(command, args, options);
      awsCalls.push(args);
      let value: unknown;
      switch (args[7]) {
        case 'list-hosted-zones-by-name':
          value = { HostedZones: [{ Id: 'Z12345', Name: 'example.com.', Config: { PrivateZone: false } }] };
          break;
        case 'get-hosted-zone':
          value = {
            HostedZone: { Name: 'example.com.', Config: { PrivateZone: false } },
            DelegationSet: { NameServers: ['ns1.aws.test', 'ns2.aws.test', 'ns3.aws.test', 'ns4.aws.test'] },
          };
          break;
        case 'list-resource-record-sets':
          value = { ResourceRecordSets: sources };
          break;
        case 'get-domain-detail':
          value = {
            AutoRenew: autoRenew,
            ExpirationDate: 1795046400,
            Nameservers: registeredServers.map((Name) => ({ Name })),
            DnssecKeys: dnssecKeys,
          };
          break;
        case 'update-domain-nameservers':
          registeredServers = args
            .slice(args.indexOf('--nameservers') + 1)
            .map((value) => value.replace(/^Name=/, ''));
          value = { OperationId: 'operation-1' };
          break;
        default:
          throw new Error(`unexpected AWS operation ${args[7]}`);
      }
      return { code: 0, stdout: JSON.stringify(value), stderr: '' };
    },
    resolve: async (name, type, servers) => {
      dnsCalls.push({ name, type, servers });
      if (!servers)
        return [
          name.startsWith('ada')
            ? '192.0.2.1'
            : name.startsWith('bob')
              ? '192.0.2.2'
              : `192.0.2.${Number(name[2]) + 2}`,
        ];
      return answers(name, type, servers[0]!);
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
  sources = [rr('MX', ['10 Mail.EXAMPLE.NET.']), rr('TXT', ['"verification"'])];
  awsCalls = [];
  dnsCalls = [];
  ds = [];
  autoRenew = true;
  registeredServers = ['old.aws.test'];
  dnssecKeys = [];
  answers = (_name, type) => (type === 'MX' ? ['10 mail.example.net.'] : ['verification']);
});
afterEach(() => world.cleanup());

describe('Route 53 mapping', () => {
  it('maps every supported type, escapes, split TXT, TTL limits and apex skips', () => {
    const mapping = mapRecords(
      [
        rr('A', ['192.0.2.1', '192.0.2.2'], '\\052.EXAMPLE.COM.', 1),
        rr('AAAA', ['2001:db8::1'], 'v6.example.com.', 999999),
        rr('CNAME', ['Target.EXAMPLE.NET.'], 'alias.example.com.'),
        rr('MX', ['10 Mail.EXAMPLE.NET.']),
        rr('TXT', ['"a\\\"b" "c\\\\d\\052"']),
        rr('SRV', ['10 20 443 Target.EXAMPLE.NET.'], '_service._tcp.example.com.'),
        rr('CAA', ['0 issue "ca.example.net"']),
        rr('NS', ['NS.EXAMPLE.NET.'], 'child.example.com.'),
        rr('NS', ['ns.aws.test.']),
        rr('SOA', ['ignored']),
        { Name: 'example.com.', Type: 'A', AliasTarget: { DNSName: 'ELB.EXAMPLE.NET.' } },
        { Name: 'example.com.', Type: 'AAAA', AliasTarget: { DNSName: 'elb.example.net.' } },
      ],
      'example.com',
      [],
    );
    expect(mapping.refusals).toEqual([]);
    expect(mapping.skipped).toHaveLength(2);
    expect(mapping.records).toEqual([
      { name: '*.example.com', type: 'A', content: '192.0.2.1', ttl: 60, proxied: false },
      { name: '*.example.com', type: 'A', content: '192.0.2.2', ttl: 60, proxied: false },
      { name: 'v6.example.com', type: 'AAAA', content: '2001:db8::1', ttl: 86400, proxied: false },
      { name: 'alias.example.com', type: 'CNAME', content: 'target.example.net', ttl: 300, proxied: false },
      {
        name: 'example.com',
        type: 'MX',
        content: 'mail.example.net',
        priority: 10,
        ttl: 300,
        proxied: false,
      },
      { name: 'example.com', type: 'TXT', content: 'a"bc\\d*', ttl: 300, proxied: false },
      {
        name: '_service._tcp.example.com',
        type: 'SRV',
        data: { priority: 10, weight: 20, port: 443, target: 'target.example.net' },
        ttl: 300,
        proxied: false,
      },
      {
        name: 'example.com',
        type: 'CAA',
        data: { flags: 0, tag: 'issue', value: 'ca.example.net' },
        ttl: 300,
        proxied: false,
      },
      { name: 'child.example.com', type: 'NS', content: 'ns.example.net', ttl: 300, proxied: false },
      { name: 'example.com', type: 'CNAME', content: 'elb.example.net', ttl: 300, proxied: false },
    ]);
  });
  it.each(['PTR', 'SPF', 'NAPTR', 'DS'])('refuses unsupported %s', (type) => {
    expect(mapRecords([rr(type, ['x'])], 'example.com', []).refusals[0]).toContain('example.com');
  });
  it.each([{ SetIdentifier: 'weighted' }, { HealthCheckId: 'health' }, { MultiValueAnswer: true }])(
    'refuses policies %j',
    (extra) => {
      expect(mapRecords([{ ...rr('A', ['192.0.2.1']), ...extra }], 'example.com', []).refusals).toHaveLength(
        1,
      );
    },
  );
  it('refuses reserved names and aliases colliding with other records', () => {
    expect(
      mapRecords([rr('TXT', ['"x"'], 'board.example.com.')], 'example.com', ['board.example.com']).refusals,
    ).toHaveLength(1);
    expect(
      mapRecords(
        [
          { Name: 'x.example.com.', Type: 'A', AliasTarget: { DNSName: 'elb.test.' } },
          rr('TXT', ['"x"'], 'x.example.com.'),
        ],
        'example.com',
        [],
      ).refusals,
    ).toHaveLength(1);
    expect(() => txtContent('"unclosed')).toThrow();
  });
});

describe('DNS commands', () => {
  it('reads the source zone and registrar from i while compute is configured for aroom', async () => {
    world.writeConfig({ route53: { profile: 'i' } });
    expect(await run('plan')).toBe(0);
    expect(awsCalls.length).toBeGreaterThan(0);
    expect(awsCalls.every((call) => call.slice(0, 4).join(' ') === '--profile i --region eu-west-1')).toBe(
      true,
    );
    awsCalls.length = 0;
    expect(await run('status')).toBe(0);
    expect(
      awsCalls
        .filter((call) => call[6] === 'route53domains')
        .every((call) => call.slice(0, 4).join(' ') === '--profile i --region us-east-1'),
    ).toBe(true);
    expect(awsCalls.some((call) => call[7] === 'update-domain-nameservers')).toBe(false);
  });

  it('normalizes hostnames and SRV/CAA API metadata while preserving TXT case', async () => {
    sources = [
      rr('CNAME', ['target.test.'], 'alias.example.com.'),
      rr('NS', ['ns.test.'], 'child.example.com.'),
      rr('SRV', ['10 20 443 target.test.'], '_s._tcp.example.com.'),
      rr('CAA', ['0 issue "ca.test"']),
      rr('TXT', ['"Case"']),
    ];
    expect(await run('import')).toBe(0);
    for (const record of world.cf.records) {
      record.name = `${record.name.toUpperCase()}.`;
      if (record.type === 'CNAME' || record.type === 'NS')
        record.content = `${record.content.toUpperCase()}.`;
      if (record.type === 'SRV') {
        record.data.target = 'TARGET.TEST.';
        record.priority = 10;
        record.content = 'ignored generated content';
      }
      if (record.type === 'CAA') record.content = 'ignored generated content';
    }
    world.cf.calls.length = 0;
    expect(await run('import', '--update')).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    sources.at(-1)!.ResourceRecords![0]!.Value = '"case"';
    expect(await run('plan')).toBe(0);
    expect(world.output).toContain('different example.com TXT');
  });
  it('refuses ambiguous zones and accepts a configured hosted zone without discovery', async () => {
    const deps = dependencies(),
      original = deps.run;
    deps.run = async (command, args, options) =>
      args[7] === 'list-hosted-zones-by-name'
        ? {
            code: 0,
            stderr: '',
            stdout: JSON.stringify({
              HostedZones: [1, 2].map((n) => ({
                Id: `Z1234${n}`,
                Name: 'example.com.',
                Config: { PrivateZone: false },
              })),
            }),
          }
        : original(command, args, options);
    expect(await runCloud(['dns', 'plan'], deps)).toBe(2);
    world.writeConfig({ route53: { hostedZoneId: 'Z12345' } });
    awsCalls.length = 0;
    expect(await run('plan')).toBe(0);
    expect(awsCalls.some((call) => call[7] === 'list-hosted-zones-by-name')).toBe(false);
  });
  it('only selects exact public zones', async () => {
    const deps = dependencies(),
      original = deps.run;
    deps.run = async (command, args, options) =>
      args[7] === 'list-hosted-zones-by-name'
        ? {
            code: 0,
            stderr: '',
            stdout: JSON.stringify({
              HostedZones: [
                { Id: 'Z12345', Name: 'example.com.', Config: { PrivateZone: true } },
                { Id: 'Z12346', Name: 'example.com.other.', Config: { PrivateZone: false } },
              ],
            }),
          }
        : original(command, args, options);
    expect(await runCloud(['dns', 'plan'], deps)).toBe(2);
    expect(world.cf.mutations()).toEqual([]);
  });
  it('refuses conflicting Cloudflare CNAMEs before creating any record', async () => {
    world.cf.records.push(
      {
        id: 'conflict',
        zone_id: world.cf.zones[0]!.id,
        name: 'example.com',
        type: 'TXT',
        content: 'keep',
        ttl: 300,
      },
      {
        id: 'cname',
        zone_id: world.cf.zones[0]!.id,
        name: 'child.example.com',
        type: 'CNAME',
        content: 'other.test',
        ttl: 300,
      },
    );
    sources.push(rr('NS', ['ns.test.'], 'child.example.com.'));
    expect(await run('import')).toBe(2);
    expect(world.cf.mutations()).toEqual([]);
  });
  it('plans read-only and imports idempotently without DELETE', async () => {
    expect(await run('plan')).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.output).toContain('create example.com MX');
    expect(await run('import')).toBe(0);
    expect(world.cf.records).toHaveLength(2);
    world.cf.calls.length = 0;
    expect(await run('import')).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(awsCalls.every((call) => !call[7]!.startsWith('delete'))).toBe(true);
  });
  it('updates different TTL only with --update, and never in dry-run', async () => {
    await run('import');
    world.cf.records[0]!.ttl = 60;
    world.cf.calls.length = 0;
    expect(await run('import')).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.output).toContain('different example.com MX');
    expect(await run('import', '--update', '--dry-run')).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(await run('import', '--update')).toBe(0);
    expect(world.cf.mutations().map((call) => call.method)).toEqual(['PATCH']);
  });
  it('matches a multivalue set before selecting a changed record', async () => {
    sources = [rr('A', ['192.0.2.1', '192.0.2.2'])];
    await run('import');
    sources = [rr('A', ['192.0.2.3', '192.0.2.2'])];
    world.cf.calls.length = 0;
    expect(await run('import', '--update')).toBe(0);
    expect(world.cf.mutations()).toHaveLength(1);
    expect(world.cf.records.map((record) => record.content).sort()).toEqual(['192.0.2.2', '192.0.2.3']);
  });
  it('warns about Cloudflare-only records except published tunnel CNAMEs', async () => {
    world.cf.records.push(
      {
        id: 'extra',
        zone_id: world.cf.zones[0]!.id,
        type: 'TXT',
        name: 'extra.example.com',
        content: 'x',
        ttl: 300,
      },
      {
        id: 'tunnel',
        zone_id: world.cf.zones[0]!.id,
        type: 'CNAME',
        name: 'board.example.com',
        content: 'id.cfargotunnel.com',
        proxied: true,
        ttl: 1,
      },
    );
    expect(await run('import', '--dry-run')).toBe(0);
    expect(world.output).toContain('WARN Cloudflare-only extra.example.com');
    expect(world.output).not.toContain('WARN Cloudflare-only board.example.com');
    expect(world.cf.mutations()).toEqual([]);
  });
  it('refuses the whole import before any mutation', async () => {
    sources.push(rr('DS', ['x']));
    expect(await run('import')).toBe(2);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.output).toContain('REFUSE example.com DS');
  });
  it('queries both Cloudflare and all four AWS authorities with resolved IPs', async () => {
    expect(await run('verify')).toBe(0);
    expect(dnsCalls.filter((call) => call.servers)).toHaveLength(12);
    expect(new Set(dnsCalls.flatMap((call) => call.servers ?? [])).size).toBe(6);
  });
  it('compares sorted responses with normalized MX hostname casing and dots', async () => {
    sources = [rr('MX', ['10 a.test.', '20 b.test.'])];
    answers = (_name, _type, server) =>
      server === '192.0.2.1' ? ['20 B.TEST.', '10 A.TEST.'] : ['10 a.test', '20 b.test'];
    expect(await run('verify')).toBe(0);
  });
  it('fails a nonalias mismatch but warns about alias addresses', async () => {
    answers = (_name, _type, server) => (server === '192.0.2.1' ? ['different'] : ['same']);
    expect(await run('verify')).toBe(1);
    sources = [{ Name: 'example.com.', Type: 'A', AliasTarget: { DNSName: 'elb.test.' } }];
    expect(await run('verify')).toBe(0);
    expect(world.output).toContain('WARN alias');
  });
  it.each(['empty', 'throw'])('reports pending authority failure separately (%s)', async (mode) => {
    world.cf.zones[0]!.status = 'pending';
    answers = (_name, _type, server) => {
      if (server === '192.0.2.1') {
        if (mode === 'throw') throw new Error('REFUSED');
        return [];
      }
      return ['same'];
    };
    expect(await run('verify')).toBe(1);
    expect(world.output).toContain('Cloudflare name server does not answer for the pending zone');
  });
  it('warns for a pending nonapex alias with CNAME answers and permits the verified switch', async () => {
    world.cf.zones[0]!.status = 'pending';
    sources = [{ Name: 'alias.example.com.', Type: 'A', AliasTarget: { DNSName: 'elb.test.' } }];
    answers = (_name, type, server) => {
      if (['192.0.2.1', '192.0.2.2'].includes(server)) return type === 'CNAME' ? ['ELB.TEST.'] : [];
      return ['192.0.2.100'];
    };
    expect(await run('verify')).toBe(0);
    expect(world.output).toContain('WARN alias alias.example.com A');
    expect(world.output).not.toContain('does not answer for the pending zone');
    expect(await run('switch')).toBe(0);
    expect(awsCalls.filter((call) => call[7] === 'update-domain-nameservers')).toHaveLength(1);
  });
  it('still refuses an alias when pending authorities provide neither address nor CNAME', async () => {
    world.cf.zones[0]!.status = 'pending';
    sources = [{ Name: 'alias.example.com.', Type: 'A', AliasTarget: { DNSName: 'elb.test.' } }];
    answers = (_name, _type, server) => (['192.0.2.1', '192.0.2.2'].includes(server) ? [] : ['192.0.2.100']);
    expect(await run('switch')).toBe(2);
    expect(world.output).toContain('does not answer for the pending zone');
    expect(awsCalls.some((call) => call[7] === 'update-domain-nameservers')).toBe(false);
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
      expect(world.output).toContain('Next: dns plan');
    } finally {
      names.forEach((name, index) => {
        COMMANDS[name]!.run = originals[index]!;
      });
    }
  });
});

describe('registrar switch', () => {
  it('verifies in the same run, updates with the selected region, and is idempotent', async () => {
    world.writeConfig({ route53: { profile: 'i' } });
    expect(await run('switch')).toBe(0);
    expect(dnsCalls.filter((call) => call.servers)).toHaveLength(12);
    const updates = awsCalls.filter((call) => call[7] === 'update-domain-nameservers');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.slice(0, 4)).toEqual(['--profile', 'i', '--region', 'us-east-1']);
    expect(updates[0]!.slice(-3)).toEqual([
      '--nameservers',
      'Name=ada.ns.cloudflare.com',
      'Name=bob.ns.cloudflare.com',
    ]);
    awsCalls.length = 0;
    dnsCalls.length = 0;
    expect(await run('switch')).toBe(0);
    expect(awsCalls.filter((call) => call[7] === 'update-domain-nameservers')).toEqual([]);
    expect(dnsCalls).toEqual([]);
    expect(world.output).toContain('unchanged domain name servers');
  });
  it('dry-run checks verification without any update', async () => {
    expect(await run('switch', '--dry-run')).toBe(0);
    expect(dnsCalls.filter((call) => call.servers)).toHaveLength(12);
    expect(awsCalls.filter((call) => call[7] === 'update-domain-nameservers')).toEqual([]);
    expect(world.cf.mutations()).toEqual([]);
  });
  it.each(['registrar', 'public'])('refuses DNSSEC from %s', async (location) => {
    if (location === 'registrar') dnssecKeys = [{ KeyTag: 123 }];
    else ds = ['123 13 2 digest'];
    expect(await run('switch')).toBe(2);
    expect(awsCalls.some((call) => call[7] === 'update-domain-nameservers')).toBe(false);
    expect(dnsCalls).toEqual([]);
  });
  it('refuses verification failure with exit 2 and no update', async () => {
    answers = (_name, _type, server) => (server === '192.0.2.1' ? ['different'] : ['same']);
    expect(await run('switch')).toBe(2);
    expect(awsCalls.some((call) => call[7] === 'update-domain-nameservers')).toBe(false);
    expect(world.output).toContain('requires green dns verify in this run');
  });
  it('rolls back to AWS authorities without contacting Cloudflare or verifying', async () => {
    expect(await run('switch', '--back')).toBe(0);
    expect(registeredServers).toEqual(['ns1.aws.test', 'ns2.aws.test', 'ns3.aws.test', 'ns4.aws.test']);
    expect(dnsCalls).toEqual([]);
    expect(world.cf.calls).toEqual([]);
    expect(world.output).toContain('WARN records changed in Cloudflare');
  });
  it.each(['AccessDenied', 'AccessDeniedException', 'InvalidInput'])(
    'refuses registrar read failure %s with exit 2',
    async (code) => {
      const deps = dependencies(),
        original = deps.run;
      deps.run = async (command, args, options) =>
        args[7] === 'get-domain-detail'
          ? {
              code: 1,
              stdout: '',
              stderr: `An error occurred (${code}) when calling GetDomainDetail: unavailable`,
            }
          : original(command, args, options);
      expect(await runCloud(['dns', 'switch'], deps)).toBe(2);
      expect(world.output).toContain(
        code.startsWith('AccessDenied') ? 'route53domains:GetDomainDetail' : 'manual step at the registrar',
      );
      expect(awsCalls.some((call) => call[7] === 'update-domain-nameservers')).toBe(false);
    },
  );
  it('preserves exit 1 for an update failure', async () => {
    const deps = dependencies(),
      original = deps.run;
    deps.run = async (command, args, options) =>
      args[7] === 'update-domain-nameservers'
        ? { code: 1, stdout: '', stderr: 'update failed' }
        : original(command, args, options);
    expect(await runCloud(['dns', 'switch'], deps)).toBe(1);
    expect(world.output).toContain('update failed');
  });
  it('treats an unavailable registrar status as a warning', async () => {
    const deps = dependencies();
    deps.run = async () => ({ code: 1, stdout: '', stderr: 'registrar unavailable' });
    world.cf.zones[0]!.status = 'pending';
    expect(await runCloud(['dns', 'status'], deps)).toBe(0);
    expect(world.output).toContain('WARN Route 53 Domains status unavailable');
    expect(world.cf.mutations()).toHaveLength(1);
  });
});
