import path from 'node:path';
import { awsPreflight, runAws } from './aws';
import { defaultConfigPath, expandHome, loadConfig } from './config';
import type { CloudContext } from './context';
import type { CloudDeps } from './deps';
import { badUsage, CloudError } from './errors';
import { Report } from './report';
import { ENV_FILE_NAME, secretsDir } from './secrets';

export const USAGE = `usage: npm run cloud -- <command> [options]
commands:
  preflight                          check the aws CLI, the login, the region, the machine type and the secrets store
  aws [--dry-run] [--rotate-keys]    create the Lightsail machine, the S3 buckets, the IAM users and their keys
options:
  --config <file>                    the configuration (default ~/.config/projectman/cloud/config.json)
  --dry-run                          only read; print what would change
  --rotate-keys                      replace the IAM access keys (the machine needs a deploy afterwards)
exit status: 0 done, 1 failed, 2 refused (a precondition is missing or the state is dangerous), 64 bad usage
`;

type Flag = 'dry-run' | 'rotate-keys';

interface Invocation {
  dryRun: boolean;
  rotateKeys: boolean;
}

interface CommandSpec {
  summary: string;
  flags: readonly Flag[];
  run(context: CloudContext, invocation: Invocation): Promise<void>;
}

/** The checks `preflight` runs one after the other; the Cloudflare part is added by a later card. */
const PREFLIGHT_CHECKS: { name: string; run(context: CloudContext): Promise<void> }[] = [
  { name: 'aws', run: awsPreflight },
];

async function preflight(context: CloudContext): Promise<void> {
  let failed = false;
  for (const check of PREFLIGHT_CHECKS) {
    try {
      await check.run(context);
    } catch (error) {
      if (!(error instanceof CloudError)) throw error;
      if (!error.reported) context.report.line(`FAIL ${check.name}: ${error.message}`);
      failed = true;
    }
  }
  if (failed) {
    const error = new CloudError('the preflight failed', 2);
    error.reported = true;
    throw error;
  }
}

/** The command table: a later card adds a row and its module. */
export const COMMANDS: Record<string, CommandSpec> = {
  preflight: {
    summary: 'check the preconditions',
    flags: [],
    run: (context) => preflight(context),
  },
  aws: {
    summary: 'create the AWS resources',
    flags: ['dry-run', 'rotate-keys'],
    run: (context, invocation) =>
      runAws(context, { dryRun: invocation.dryRun, rotateKeys: invocation.rotateKeys }),
  },
};

interface Parsed {
  command: string;
  config: string | null;
  flags: Set<Flag>;
}

function parse(argv: readonly string[]): Parsed {
  const [command, ...rest] = argv;
  if (!command) throw badUsage(`no command\n${USAGE}`);
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!spec) throw badUsage(`unknown command "${command}"\n${USAGE}`);
  const flags = new Set<Flag>();
  let config: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    const equals = token.indexOf('=');
    const name = (equals === -1 ? token : token.slice(0, equals)).replace(/^--/, '');
    if (!token.startsWith('--')) throw badUsage(`unexpected argument "${token}"\n${USAGE}`);
    if (name === 'config') {
      const value = equals === -1 ? rest[index + 1] : token.slice(equals + 1);
      if (value === undefined || value === '' || value.startsWith('--'))
        throw badUsage(`--config needs a file\n${USAGE}`);
      if (equals === -1) index += 1;
      config = value;
      continue;
    }
    if (equals !== -1 || !(spec.flags as readonly string[]).includes(name))
      throw badUsage(`"${token}" is not an option of ${command}\n${USAGE}`);
    flags.add(name as Flag);
  }
  return { command, config, flags };
}

/** Parses the command line and runs the command; returns the exit status. */
export async function runCloud(argv: readonly string[], deps: CloudDeps): Promise<number> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    deps.out(USAGE.trimEnd());
    return 0;
  }
  const report = new Report((line) => deps.out(line));
  try {
    const parsed = parse(argv);
    const configFile = parsed.config
      ? path.resolve(expandHome(parsed.config, deps.homeDir))
      : defaultConfigPath(deps.homeDir);
    const config = loadConfig(configFile, deps.homeDir);
    const dir = secretsDir(deps.homeDir);
    const context: CloudContext = {
      deps,
      config,
      report,
      secretsDir: dir,
      envFile: path.join(dir, ENV_FILE_NAME),
    };
    await COMMANDS[parsed.command]!.run(context, {
      dryRun: parsed.flags.has('dry-run'),
      rotateKeys: parsed.flags.has('rotate-keys'),
    });
    return 0;
  } catch (error) {
    if (error instanceof CloudError) {
      if (!error.reported)
        deps.err(error.exitCode === 64 ? error.message : `FAIL ${argv[0] ?? 'cloud'}: ${error.message}`);
      return error.exitCode;
    }
    deps.err(`FAIL ${argv[0] ?? 'cloud'}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
