import path from 'node:path';
import { awsPreflight, runAws } from './aws';
import { defaultConfigPath, expandHome, loadConfig } from './config';
import type { CloudContext } from './context';
import type { CloudDeps } from './deps';
import { badUsage, CloudError } from './errors';
import {
  runDeploy,
  runLogs,
  runPullData,
  runRehearse,
  runRollback,
  runSeed,
  runSsh,
  runStart,
  runStatus,
  runStop,
} from './machine';
import { Report } from './report';
import { ENV_FILE_NAME, secretsDir } from './secrets';

export const USAGE = `usage: npm run cloud -- <command> [options]
commands:
  preflight                          check the aws CLI, the login, the region, the machine type and the secrets store
  aws [--dry-run] [--rotate-keys]    create the Lightsail machine, the S3 buckets, the IAM users and their keys
  deploy [--ref <tag|sha>] [--dry-run]
                                     install or update the board on the machine (default: the newest release tag)
  rollback [--dry-run]               go back to the previous image
  status                             the machine, the unit, the container, the deploy history, disk and memory
  logs [--lines <n>]                 the last lines of the board's log (default 200)
  ssh                                a shell on the machine
  stop [--dry-run]                   stop the board (the data stays)
  start [--dry-run]                  start the board again
  rehearse                           restore the replica and the snapshot in a scratch container on the machine
  seed --from <dir> [--ref <tag|sha>] [--dry-run]
                                     fill an empty machine with the package of \`npm run migrate -- hybrid package\`, then deploy
  pull-data --to <new dir> [--dry-run]
                                     copy the stopped board's data to a new directory on this computer
options:
  --config <file>                    the configuration (default ~/.config/projectman/cloud/config.json)
  --dry-run                          only read; print what would change
  --rotate-keys                      replace the IAM access keys (the machine needs a deploy afterwards)
exit status: 0 done, 1 failed, 2 refused (a precondition is missing or the state is dangerous), 64 bad usage
`;

type Flag = 'dry-run' | 'rotate-keys';
type ValueOption = 'ref' | 'lines' | 'from' | 'to';

interface Invocation {
  dryRun: boolean;
  rotateKeys: boolean;
  values: Partial<Record<ValueOption, string>>;
}

interface CommandSpec {
  summary: string;
  flags: readonly Flag[];
  values?: readonly ValueOption[];
  /** The value options the command cannot do without. */
  required?: readonly ValueOption[];
  run(context: CloudContext, invocation: Invocation): Promise<void>;
}

function logLines(value: string | undefined): number {
  if (value === undefined) return 200;
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 10_000)
    throw badUsage(`--lines needs a whole number from 1 to 10000\n${USAGE}`);
  return Number(value);
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
  deploy: {
    summary: 'install or update the board',
    flags: ['dry-run'],
    values: ['ref'],
    run: (context, invocation) =>
      runDeploy(context, { ref: invocation.values.ref ?? null, dryRun: invocation.dryRun }),
  },
  rollback: {
    summary: 'go back to the previous image',
    flags: ['dry-run'],
    run: (context, invocation) => runRollback(context, { dryRun: invocation.dryRun }),
  },
  status: {
    summary: 'show the machine and the board',
    flags: [],
    run: (context) => runStatus(context),
  },
  logs: {
    summary: 'show the board log',
    flags: [],
    values: ['lines'],
    run: (context, invocation) => runLogs(context, { lines: logLines(invocation.values.lines) }),
  },
  ssh: {
    summary: 'a shell on the machine',
    flags: [],
    run: (context) => runSsh(context),
  },
  stop: {
    summary: 'stop the board',
    flags: ['dry-run'],
    run: (context, invocation) => runStop(context, { dryRun: invocation.dryRun }),
  },
  start: {
    summary: 'start the board',
    flags: ['dry-run'],
    run: (context, invocation) => runStart(context, { dryRun: invocation.dryRun }),
  },
  rehearse: {
    summary: 'rehearse the restore on the machine',
    flags: [],
    run: (context) => runRehearse(context),
  },
  seed: {
    summary: 'fill an empty machine with the migrated data',
    flags: ['dry-run'],
    values: ['from', 'ref'],
    required: ['from'],
    run: (context, invocation) =>
      runSeed(context, {
        from: invocation.values.from!,
        ref: invocation.values.ref ?? null,
        dryRun: invocation.dryRun,
      }),
  },
  'pull-data': {
    summary: 'copy the stopped board data to this computer',
    flags: ['dry-run'],
    values: ['to'],
    required: ['to'],
    run: (context, invocation) =>
      runPullData(context, { to: invocation.values.to!, dryRun: invocation.dryRun }),
  },
};

interface Parsed {
  command: string;
  config: string | null;
  flags: Set<Flag>;
  values: Partial<Record<ValueOption, string>>;
}

function parse(argv: readonly string[]): Parsed {
  const [command, ...rest] = argv;
  if (!command) throw badUsage(`no command\n${USAGE}`);
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!spec) throw badUsage(`unknown command "${command}"\n${USAGE}`);
  const flags = new Set<Flag>();
  const values: Partial<Record<ValueOption, string>> = {};
  let config: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    const equals = token.indexOf('=');
    const name = (equals === -1 ? token : token.slice(0, equals)).replace(/^--/, '');
    if (!token.startsWith('--')) throw badUsage(`unexpected argument "${token}"\n${USAGE}`);
    const takesValue = name === 'config' || (spec.values as readonly string[] | undefined)?.includes(name);
    if (takesValue) {
      const value = equals === -1 ? rest[index + 1] : token.slice(equals + 1);
      if (value === undefined || value === '' || value.startsWith('--'))
        throw badUsage(`--${name} needs a value\n${USAGE}`);
      if (equals === -1) index += 1;
      if (name === 'config') config = value;
      else values[name as ValueOption] = value;
      continue;
    }
    if (equals !== -1 || !(spec.flags as readonly string[]).includes(name))
      throw badUsage(`"${token}" is not an option of ${command}\n${USAGE}`);
    flags.add(name as Flag);
  }
  for (const name of spec.required ?? [])
    if (values[name] === undefined) throw badUsage(`${command} needs --${name}\n${USAGE}`);
  return { command, config, flags, values };
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
      values: parsed.values,
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
