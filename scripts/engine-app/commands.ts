import path from 'node:path';
import { CloudError, badUsage } from '../cloud/errors';
import type { EnginePackageRequest } from './package';

const USAGE = 'usage: npm run engine-app -- package --commit <sha> --out <dir> [--repo <https-url>]';

export interface EngineAppCliDeps {
  /** The remote the commit is fetched from when `--repo` is absent: `origin` of the source checkout. */
  originUrl(): Promise<string | null>;
  sourceRepo: string;
  cwd: string;
  build(request: EnginePackageRequest): Promise<{ root: string }>;
  out(text: string): void;
  err(text: string): void;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** `package --commit <sha> --out <dir> [--repo <url>]`. Exit status: 0 done, 1 failed, 2 refused, 64 wrong usage. */
export async function runEngineAppCli(argv: string[], deps: EngineAppCliDeps): Promise<number> {
  try {
    const [command, ...args] = argv;
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
    if (!(error instanceof CloudError)) throw error;
    deps.err(`engine-app: ${error.message}`);
    return error.exitCode;
  }
}
