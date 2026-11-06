import path from 'node:path';
import { CloudError, badUsage } from '../cloud/errors';
import type { EnginePackageRequest } from './package';
import type { EngineAppBuildRequest } from './build';
import { ComputeJobCommit, RELEASE_TAG_PATTERN } from '@projectman/shared';
import { runNumber } from '../cloud/compute-job-run';
import type { EngineAppFetchRequest } from './fetch';

const FETCH_USAGE =
  'usage: npm run engine-app -- fetch --commit <sha> --out <new directory> [--run <number>] [--dry-run] [--open]';
const UPLOAD_USAGE = 'usage: npm run engine-app -- upload --tag <tag> --dir <build output directory>';
const USAGE =
  'usage: npm run engine-app -- package --commit <sha> --out <dir> [--repo <https-url>] | build --package <dir> --out <dir> [--ad-hoc [--update-ref refs/heads/<branch>] | --identity <name> --team-id <id> --notary-profile <name>] | publish --tag <tag> --config <absolute-file> | upload --tag <tag> --dir <dir> | fetch --commit <sha> --out <new directory> [--run <number>] [--dry-run] [--open]';

export interface EngineAppCliDeps {
  /** The remote the commit is fetched from when `--repo` is absent: `origin` of the source checkout. */
  originUrl(): Promise<string | null>;
  sourceRepo: string;
  cwd: string;
  build(request: EnginePackageRequest): Promise<{ root: string }>;
  buildApp?(request: EngineAppBuildRequest): Promise<{ root: string }>;
  publish?(request: { tag: string; config?: string; repositoryUrl: string }): Promise<void>;
  /** Puts an already built app on the tag's existing release (PM-1198). */
  upload?(request: { tag: string; dir: string; repositoryUrl: string }): Promise<void>;
  /** Downloads the GitHub-built app; returns its path (with `dryRun`, the address of the run). */
  fetch?(request: EngineAppFetchRequest): Promise<string>;
  out(text: string): void;
  err(text: string): void;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Engine package/app commands. Exit status: 0 done, 1 failed, 2 refused, 64 wrong usage. */
export async function runEngineAppCli(argv: string[], deps: EngineAppCliDeps): Promise<number> {
  try {
    const [command, ...args] = argv;
    if (command === 'publish') {
      const seen = new Set<string>();
      for (let index = 0; index < args.length; index += 2) {
        const key = args[index]!;
        if (
          !['--tag', '--config'].includes(key) ||
          seen.has(key) ||
          !args[index + 1] ||
          args[index + 1]!.startsWith('--')
        )
          throw badUsage('usage: npm run engine-app -- publish --tag <tag> --config <absolute-file>');
        seen.add(key);
      }
      const tag = option(args, '--tag');
      const config = option(args, '--config');
      if (!tag || !RELEASE_TAG_PATTERN.test(tag) || (config && !path.isAbsolute(config)) || !deps.publish)
        throw badUsage('publish requires --tag <release-tag> and an absolute --config path');
      const repositoryUrl = await deps.originUrl();
      if (!repositoryUrl) throw badUsage('the source checkout has no origin remote');
      await deps.publish({ tag, config, repositoryUrl });
      deps.out(`published engine app for ${tag}`);
      return 0;
    }
    if (command === 'upload') {
      const seen = new Set<string>();
      for (let index = 0; index < args.length; index += 2) {
        const key = args[index]!;
        if (
          !['--tag', '--dir'].includes(key) ||
          seen.has(key) ||
          !args[index + 1] ||
          args[index + 1]!.startsWith('--')
        )
          throw badUsage(UPLOAD_USAGE);
        seen.add(key);
      }
      const tag = option(args, '--tag');
      const dir = option(args, '--dir');
      if (!tag || !RELEASE_TAG_PATTERN.test(tag) || !dir || !deps.upload) throw badUsage(UPLOAD_USAGE);
      const repositoryUrl = await deps.originUrl();
      if (!repositoryUrl) throw badUsage('the source checkout has no origin remote');
      await deps.upload({ tag, dir: path.resolve(deps.cwd, dir), repositoryUrl });
      deps.out(`uploaded engine app for ${tag}`);
      return 0;
    }
    if (command === 'fetch') {
      const allowed = new Set(['--commit', '--out', '--run']);
      const seen = new Set<string>();
      for (let index = 0; index < args.length; index++) {
        const key = args[index]!;
        if (seen.has(key)) throw badUsage(FETCH_USAGE);
        seen.add(key);
        if (key === '--dry-run' || key === '--open') continue;
        if (!allowed.has(key) || !args[index + 1] || args[index + 1]!.startsWith('--'))
          throw badUsage(FETCH_USAGE);
        index++;
      }
      const commit = option(args, '--commit');
      const out = option(args, '--out');
      const run = option(args, '--run');
      if (!commit || !ComputeJobCommit.safeParse(commit).success || !out || !deps.fetch)
        throw badUsage(FETCH_USAGE);
      const app = await deps.fetch({
        commit,
        out: path.resolve(deps.cwd, out),
        ...(run === undefined ? {} : { run: runNumber('engine-app fetch', run) }),
        dryRun: args.includes('--dry-run'),
        open: args.includes('--open'),
      });
      deps.out(app);
      return 0;
    }
    if (command === 'build') {
      const allowed = new Set([
        '--package',
        '--out',
        '--identity',
        '--team-id',
        '--notary-profile',
        '--update-ref',
      ]);
      const seen = new Set<string>();
      for (let index = 0; index < args.length; index++) {
        const key = args[index]!;
        if (seen.has(key)) throw badUsage(USAGE);
        seen.add(key);
        if (key === '--ad-hoc') continue;
        if (!allowed.has(key) || !args[index + 1] || args[index + 1]!.startsWith('--')) throw badUsage(USAGE);
        index++;
      }
      if (
        seen.has('--ad-hoc') &&
        ['--identity', '--team-id', '--notary-profile'].some((key) => seen.has(key))
      )
        throw badUsage('--ad-hoc cannot be combined with signing options');
      if (seen.has('--update-ref') && !seen.has('--ad-hoc')) throw badUsage('--update-ref needs --ad-hoc');
      const packageDir = option(args, '--package');
      const outDir = option(args, '--out');
      if (!packageDir || !outDir || !deps.buildApp) throw badUsage(USAGE);
      const originUrl = await deps.originUrl();
      if (!originUrl) throw badUsage('the source checkout has no origin remote');
      const { root } = await deps.buildApp({
        packageDir: path.resolve(deps.cwd, packageDir),
        outDir: path.resolve(deps.cwd, outDir),
        sourceRepo: deps.sourceRepo,
        originUrl,
        adHoc: args.includes('--ad-hoc'),
        identity: option(args, '--identity'),
        teamId: option(args, '--team-id'),
        notaryProfile: option(args, '--notary-profile'),
        updateRef: option(args, '--update-ref'),
      });
      deps.out(root);
      return 0;
    }
    if (command !== 'package') throw badUsage(USAGE);
    const commit = option(args, '--commit');
    const out = option(args, '--out');
    if (!commit || !out) throw badUsage(USAGE);
    const repositoryUrl = option(args, '--repo') ?? (await deps.originUrl());
    if (!repositoryUrl) throw badUsage('the source checkout has no origin remote: pass --repo <https-url>');
    const { root } = await deps.build({
      commit,
      outDir: path.resolve(deps.cwd, out),
      repositoryUrl,
      sourceRepo: deps.sourceRepo,
    });
    deps.out(root);
    return 0;
  } catch (error) {
    deps.err(`engine-app: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof CloudError ? error.exitCode : 1;
  }
}
