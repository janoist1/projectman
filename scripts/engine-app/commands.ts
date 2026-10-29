import path from 'node:path';
import { CloudError, badUsage } from '../cloud/errors';
import type { EnginePackageRequest } from './package';
import type { EngineAppBuildRequest } from './build';

const USAGE =
  'usage: npm run engine-app -- package --commit <sha> --out <dir> [--repo <https-url>] | build --package <dir> --out <dir> [--ad-hoc | --identity <name> --team-id <id> --notary-profile <name>]';

export interface EngineAppCliDeps {
  /** The remote the commit is fetched from when `--repo` is absent: `origin` of the source checkout. */
  originUrl(): Promise<string | null>;
  sourceRepo: string;
  cwd: string;
  build(request: EnginePackageRequest): Promise<{ root: string }>;
  buildApp?(request: EngineAppBuildRequest): Promise<{ root: string }>;
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
    if (command === 'build') {
      const allowed = new Set(['--package', '--out', '--identity', '--team-id', '--notary-profile']);
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
