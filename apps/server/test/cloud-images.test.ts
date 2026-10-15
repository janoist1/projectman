import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import {
  archiveDigest,
  bundleSchema,
  runImageBuild,
  selectedImage,
  verifyImage,
} from '../../../scripts/cloud/images';
import type { CloudContext } from '../../../scripts/cloud/context';
import { loadConfig } from '../../../scripts/cloud/config';
import { Report } from '../../../scripts/cloud/report';
import { HostWorld, SHA_NEW, SHA_OLD } from './helpers/fake-host';
import { Ec2HostWorld } from './helpers/fake-ec2-host';
import { baseConfig } from './helpers/fake-aws';
import { EC2_CONFIG } from './helpers/fake-ec2';

const ID = `sha256:${'1'.repeat(64)}`;
const OLD_ID = `sha256:${'2'.repeat(64)}`;
let world: HostWorld;
let directory: string;
beforeEach(() => {
  world = HostWorld.ready();
  directory = path.join(fs.realpathSync(world.home), 'bundle');
  fs.mkdirSync(directory);
});
afterEach(() => world.cleanup());

function bundle(sha = SHA_NEW) {
  const images = (['amd64', 'arm64'] as const).map((arch) => {
    const archive = `linux-${arch}.tar`;
    fs.writeFileSync(path.join(directory, archive), `fake ${arch} archive`);
    return {
      platform: `linux/${arch}`,
      archive,
      ...archiveDigest(path.join(directory, archive)),
      imageId: ID,
    };
  });
  const value = { version: 1, sourceSha: sha, images };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(value));
  world.writeConfig({ deployment: { imageBundle: directory } });
  return value;
}
function context(): CloudContext {
  return {
    deps: world.deps(),
    config: loadConfig(world.configFile, world.home),
    report: new Report(() => {}),
    secretsDir: world.secretsDir,
    envFile: world.envFile,
  };
}
function arm() {
  world.cleanup();
  world = Ec2HostWorld.configured();
  directory = path.join(fs.realpathSync(world.home), 'bundle');
  fs.mkdirSync(directory);
  bundle();
  world.writeConfig({
    aws: {
      ...(baseConfig().aws as object),
      compute: 'ec2',
      profile: 'aroom',
      ec2: { ...EC2_CONFIG, architecture: 'arm64' },
    },
    deployment: { imageBundle: directory },
  });
}
const calls = () => world.hostCalls.map((call) => call.subcommand);

describe('image bundles and pinned deployment', () => {
  it('selects the platform and reports the exact source and digests', () => {
    bundle();
    expect(selectedImage(context(), SHA_NEW)).toMatchObject({
      sourceSha: SHA_NEW,
      platform: 'linux/amd64',
      imageId: ID,
    });
  });
  it.each(['duplicate', 'traversal', 'unknown', 'source', 'hash', 'size', 'symlink', 'partial'])(
    'refuses %s before any host call',
    async (scenario) => {
      const value = bundle();
      if (scenario === 'duplicate') value.images[1] = value.images[0]!;
      if (scenario === 'traversal') value.images[0]!.archive = '../linux-amd64.tar';
      if (scenario === 'unknown') Object.assign(value.images[0]!, { secret: 'unexpected' });
      if (scenario === 'source') value.sourceSha = SHA_OLD;
      if (scenario === 'hash') fs.appendFileSync(path.join(directory, 'linux-amd64.tar'), 'tamper');
      if (scenario === 'size') value.images[0]!.archiveBytes++;
      if (scenario === 'symlink') {
        fs.renameSync(path.join(directory, 'linux-amd64.tar'), path.join(directory, 'other.tar'));
        fs.symlinkSync('other.tar', path.join(directory, 'linux-amd64.tar'));
      }
      if (scenario === 'partial') value.images.pop();
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(value));
      expect(await runCloud(['deploy', '--ref', SHA_NEW], world.deps())).toBe(2);
      expect(world.hostCalls).toEqual([]);
      expect(world.machine.built).toEqual([]);
    },
  );
  it('validates the artifact in deploy dry-run without host access', async () => {
    bundle();
    expect(await runCloud(['deploy', '--ref', SHA_NEW, '--dry-run'], world.deps())).toBe(0);
    expect(world.hostCalls).toEqual([]);
    expect(world.output).toContain(ID);
  });
  it.each(['deploy', 'seed'])(
    'ARM %s imports and pins without host build, preserving the seed integrity order',
    async (command) => {
      arm();
      const source = path.join(world.home, 'package');
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'db.sqlite'), 'closed DB');
      world.aws.addBucket('acme-projectman-db');
      world.aws.addBucket('acme-projectman-backup');
      expect(
        await runCloud(
          [command, '--ref', SHA_NEW, ...(command === 'seed' ? ['--from', source] : [])],
          world.deps(),
        ),
      ).toBe(0);
      expect(calls()).not.toContain('build');
      expect(world.machine.built).toEqual([]);
      expect(world.hostCalls.find((call) => call.subcommand === 'receive-image')!.args).toEqual([
        SHA_NEW,
        'linux/arm64',
        expect.any(String),
        expect.stringMatching(/^[a-f0-9]{64}$/),
        ID,
      ]);
      expect(world.hostCalls.find((call) => call.subcommand === 'start')!.args).toEqual([
        SHA_NEW,
        SHA_NEW,
        ID,
      ]);
      if (command === 'seed')
        expect(calls().indexOf('seed-digest')).toBeLessThan(calls().indexOf('receive-image'));
      expect(calls().indexOf('receive-image')).toBeLessThan(calls().indexOf('receive-env'));
    },
  );
  it.each([
    [0, '{}'],
    [0, 'not JSON'],
    [0, JSON.stringify({ imageId: OLD_ID, platform: 'linux/amd64', revision: SHA_NEW })],
    [1, ''],
    [3, ''],
  ])('does not start after invalid import response (%s, %s)', async (code, stdout) => {
    bundle();
    world.machine.failures.set('receive-image', {
      code: code as number,
      stdout: stdout as string,
      stderr: '',
    });
    expect(await runCloud(['deploy', '--ref', SHA_NEW], world.deps())).toBe(code === 3 ? 2 : 1);
    expect(calls()).not.toContain('start');
    expect(calls()).not.toContain('receive-env');
    expect(calls()).not.toContain('build');
  });
  it.each(['rollback', 'start'])('carries the recorded ID through %s', async (command) => {
    arm();
    world.machine.preload(SHA_NEW, SHA_NEW, { sha: SHA_OLD, ref: SHA_OLD });
    Object.assign(world.machine.deploy!.current!, { imageId: ID, platform: 'linux/arm64' });
    Object.assign(world.machine.deploy!.previous!, { imageId: OLD_ID, platform: 'linux/arm64' });
    expect(await runCloud([command], world.deps())).toBe(0);
    expect(world.hostCalls.find((call) => call.subcommand === 'start')!.args[2]).toBe(
      command === 'start' ? ID : OLD_ID,
    );
  });
  it('rolls back an unhealthy prebuilt deployment with the previous immutable ID', async () => {
    arm();
    world.machine.preload(SHA_OLD, SHA_OLD);
    Object.assign(world.machine.deploy!.current!, { imageId: OLD_ID, platform: 'linux/arm64' });
    world.machine.unhealthyShas.add(SHA_NEW);
    expect(await runCloud(['deploy', '--ref', SHA_NEW], world.deps())).toBe(1);
    expect(world.hostCalls.filter((call) => call.subcommand === 'start').map((call) => call.args)).toEqual([
      [SHA_NEW, SHA_NEW, ID],
      [SHA_OLD, SHA_OLD, OLD_ID],
    ]);
    expect(world.output).toContain('is healthy again');
  });
  it('does not accept healthy status for a different actual container ID', async () => {
    bundle();
    const deps = world.deps();
    const run = deps.run;
    deps.run = async (...args) => {
      const result = await run(...args);
      if (args[0] === 'ssh' && result.stdout.startsWith('{"unit"')) {
        const status = JSON.parse(result.stdout);
        status.imageId = OLD_ID;
        return { ...result, stdout: JSON.stringify(status) };
      }
      return result;
    };
    expect(await runCloud(['deploy', '--ref', SHA_NEW], deps)).toBe(1);
    expect(world.output).toContain('FAIL health');
  });
  it('refuses ARM rollback from a legacy record', async () => {
    arm();
    world.machine.preload(SHA_NEW, SHA_NEW, { sha: SHA_OLD, ref: SHA_OLD });
    expect(await runCloud(['rollback'], world.deps())).toBe(2);
    expect(calls()).not.toContain('start');
  });
});

describe('builder', () => {
  const inspected = (platform = 'amd64') => [
    {
      Id: ID,
      Os: 'linux',
      Architecture: platform,
      Config: {
        Labels: { 'org.opencontainers.image.revision': SHA_NEW },
        Env: [`PROJECTMAN_VERSION=${SHA_NEW}`],
      },
    },
  ];
  it.each(['Id', 'Os', 'Architecture', 'Labels', 'Env'])('checks actual image %s', (field) => {
    const value = inspected();
    if (field === 'Labels') value[0]!.Config.Labels['org.opencontainers.image.revision'] = SHA_OLD;
    else if (field === 'Env') value[0]!.Config.Env = [`PROJECTMAN_VERSION=${SHA_OLD}`];
    else Object.assign(value[0]!, { [field]: 'wrong' });
    expect(() => verifyImage(value, ID, 'linux/amd64', SHA_NEW)).toThrow();
  });
  function fakeBuilder(scenario = '') {
    const ctx = context();
    const commands: string[][] = [];
    let platform = 'linux/amd64';
    const config = () =>
      JSON.stringify({ os: 'linux', architecture: platform.split('/')[1], config: inspected()[0]!.Config });
    const imageId = () => `sha256:${createHash('sha256').update(config()).digest('hex')}`;
    ctx.deps.run = async (command, args) => {
      commands.push([command, ...args]);
      let stdout = '';
      if (command === 'git')
        stdout = args.includes('rev-parse')
          ? `${scenario === 'head' ? SHA_OLD : SHA_NEW}\n`
          : scenario === 'dirty'
            ? ' M dirty\n'
            : '';
      if (args[0] === 'buildx' && args[1] === 'inspect')
        stdout =
          scenario === 'driver'
            ? 'Driver: docker\nPlatforms: linux/amd64, linux/arm64\n'
            : 'Driver: docker-container\nPlatforms: linux/amd64, linux/arm64\n';
      if (args[0] === 'buildx' && args[1] === 'build') {
        platform = args[args.indexOf('--platform') + 1]!;
        if (scenario === 'partial' && platform === 'linux/arm64')
          return { code: 1, stdout: '', stderr: 'export failed' };
        const file = args[args.indexOf('--output') + 1]!.replace('type=docker,dest=', '');
        fs.writeFileSync(file, platform);
        fs.writeFileSync(
          args[args.indexOf('--metadata-file') + 1]!,
          JSON.stringify({
            'containerimage.config.digest':
              scenario === 'metadata' ? 'bad' : scenario === 'digest' ? ID : imageId(),
          }),
        );
      }
      if (command === 'tar')
        stdout =
          args.at(-1) === 'manifest.json'
            ? JSON.stringify([
                { Config: `${imageId().slice(7)}.json`, RepoTags: [`projectman-cloud:${SHA_NEW}`] },
              ])
            : config();
      if (args[0] === 'image')
        stdout = JSON.stringify([{ ...inspected(platform.split('/')[1])[0]!, Id: imageId() }]);
      return { code: 0, stdout, stderr: '' };
    };
    ctx.deps.pipe = async (_from, to) => {
      if (scenario === 'source-secret')
        fs.writeFileSync(path.join(to.args[to.args.indexOf('-C') + 1]!, 'cloud.env'), 'FAKE_RUNTIME=value');
      return { code: 0, stdout: '', stderr: '' };
    };
    return { ctx, commands };
  }
  it('builds both exports at one SHA and only then publishes a strict manifest', async () => {
    const { ctx, commands } = fakeBuilder();
    const out = path.join(fs.realpathSync(world.home), 'new-output');
    await runImageBuild(ctx, SHA_NEW, out, false);
    const builds = commands.filter((entry) => entry[1] === 'buildx' && entry[2] === 'build');
    expect(builds).toHaveLength(2);
    for (const [index, platform] of ['linux/amd64', 'linux/arm64'].entries()) {
      expect(builds[index]).toEqual(
        expect.arrayContaining([
          '--platform',
          platform,
          '--build-arg',
          `PROJECTMAN_VERSION=${SHA_NEW}`,
          '--tag',
          `projectman-cloud:${SHA_NEW}`,
        ]),
      );
      expect(builds[index]).not.toContain('--push');
    }
    expect(
      bundleSchema.parse(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))).sourceSha,
    ).toBe(SHA_NEW);
    expect(fs.existsSync(path.join(out, 'source'))).toBe(false);
  });
  it.each(['dirty', 'head', 'partial', 'metadata', 'digest', 'driver', 'source-secret'])(
    'leaves no valid manifest after %s failure',
    async (scenario) => {
      const { ctx } = fakeBuilder(scenario);
      const out = path.join(fs.realpathSync(world.home), 'new-output');
      await expect(runImageBuild(ctx, SHA_NEW, out, false)).rejects.toThrow();
      expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(false);
    },
  );
  it('dry-run never exports, builds or creates output', async () => {
    const { ctx, commands } = fakeBuilder();
    const out = path.join(fs.realpathSync(world.home), 'new-output');
    await runImageBuild(ctx, SHA_NEW, out, true);
    expect(fs.existsSync(out)).toBe(false);
    expect(commands.filter((entry) => entry[1] === 'buildx')).toHaveLength(1);
  });
  it('refuses existing, in-repository, missing-parent and symlinked output locations', async () => {
    const { ctx, commands } = fakeBuilder();
    const link = path.join(fs.realpathSync(world.home), 'linked');
    fs.symlinkSync(directory, link);
    for (const out of [
      directory,
      path.join(ctx.deps.repoRoot, 'new-output'),
      path.join(directory, 'missing', 'new-output'),
      path.join(link, 'new-output'),
    ]) {
      await expect(runImageBuild(ctx, SHA_NEW, out, true)).rejects.toMatchObject({ exitCode: 2 });
    }
    expect(commands).toEqual([]);
  });
  it.each(
    [[], ['--ref', SHA_NEW], ['--ref', 'main', '--out', 'out'], ['--ref', SHA_NEW, '--out', 'bad,out']].map(
      (args) => ({ args }),
    ),
  )('rejects invalid CLI args $args as usage', async ({ args }) => {
    expect(await runCloud(['image-build', ...args], world.deps())).toBe(64);
  });
});
