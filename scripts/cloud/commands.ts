import path from 'node:path';
import { awsPreflight, runAws } from './aws';
import { runCheck } from './cloudflare-check';
import { runPublish } from './cloudflare-publish';
import { cloudflareApi, cloudflarePreflight, findZone, resolveAccount, runEdge } from './cloudflare';
import { defaultConfigPath, expandHome, loadConfig } from './config';
import type { CloudContext } from './context';
import type { CloudDeps } from './deps';
import { badUsage, CloudError } from './errors';
import { runDnsPlan, runDnsStatus, runDnsSwitch, runDnsVerify } from './dns';
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
import { runImageBuild, selectedImage, sourceShaSchema } from './images';
import { ENV_FILE_NAME, secretsDir } from './secrets';
import { runSesCheck, runSesConfigure, runSesPlan, runSesRequestProduction } from './ses';
import { runTrialResetApply, runTrialResetPlan } from './trial-reset';

export const USAGE = `usage: npm run cloud -- <command> [options]
commands:
  image-build --ref <SHA40> --out <new directory> [--dry-run]
                                     build and verify amd64 and arm64 archives on the admin builder
  preflight                          check the aws CLI, the login, the region, the machine type and the secrets store
  aws [--dry-run] [--rotate-keys]    create the EC2 or Lightsail machine, the S3 buckets, the IAM users and their keys
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
  trial-reset-plan --from <FINAL_RETURN_DIRECTORY> --rollback-event <EVENT_ID> --out <NEW_PLAN_JSON> --config <file>
                                     inventory the stopped EC2 trial target; write a private plan for owner approval
  trial-reset-apply --plan <PLAN_JSON> --confirm-sha256 <PLAN_FILE_SHA256> [--dry-run] --config <file>
                                     archive host data and conditionally delete only the approved trial objects
  edge [--dry-run] [--rotate-engine-token] [--rotate-integrator-token]
                                     set up Cloudflare: zone, edge settings, Access, service tokens, tunnel
                                     (access.boardMode: private = Access in front, public = the board's own login, only /engine guarded)
  publish [--feedback] [--dry-run]   point the hostname at the tunnel (after the checks); --feedback: the feedback hostname too
                                     (a public board is published only when the running board and the tunnel agree)
  check --login-json <file>          verify the public board: Access (or the public matrix), edge, origin rules, the engine's doors
  dns plan|import|verify|status       migrate and verify Route 53 DNS; import accepts --update and --dry-run
  dns switch [--back] [--dry-run]     change registrar name servers after verification; --back: restore Route 53
  ses plan                           read the SES identity/account/DNS and preview sender provisioning
  ses configure [--dry-run]          configure SES DKIM, sending-only IAM and protected cloud.env
  ses request-production [--dry-run] request production access separately after owner approval
  ses check                          verify SES production, DKIM, DNS and the sender scope without sending mail
  up [--login-json <file>] [--dry-run] run preflight, aws, edge, deploy, publish, then check with a login file
options:
  --config <file>                    the configuration (default ~/.config/projectman/cloud/config.json)
  --dry-run                          only read; print what would change
  --rotate-keys                      replace the IAM access keys (the machine needs a deploy afterwards)
  --rotate-engine-token              replace the secret of the engine's service token (the engine needs the new file)
  --rotate-integrator-token          replace the secret of the integrator's service token
exit status: 0 done, 1 failed, 2 refused (a precondition is missing or the state is dangerous), 64 bad usage
`;

type Flag =
  | 'dry-run'
  | 'rotate-keys'
  | 'rotate-engine-token'
  | 'rotate-integrator-token'
  | 'feedback'
  | 'update'
  | 'back';
type ValueOption =
  'ref' | 'lines' | 'from' | 'to' | 'login-json' | 'out' | 'rollback-event' | 'plan' | 'confirm-sha256';

interface Invocation {
  dryRun: boolean;
  rotateKeys: boolean;
  flags: ReadonlySet<Flag>;
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

/** The checks `preflight` runs one after the other. */
const PREFLIGHT_CHECKS: { name: string; run(context: CloudContext): Promise<void> }[] = [
  {
    name: 'image',
    run: async (context) => {
      selectedImage(context);
    },
  },
  { name: 'aws', run: awsPreflight },
  { name: 'cloudflare', run: cloudflarePreflight },
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
  'trial-reset-plan': {
    summary: 'write a private read-only EC2 trial reset plan',
    flags: [],
    values: ['from', 'rollback-event', 'out'],
    required: ['from', 'rollback-event', 'out'],
    run: (context, invocation) =>
      runTrialResetPlan(
        context,
        invocation.values.from!,
        invocation.values['rollback-event']!,
        invocation.values.out!,
      ),
  },
  'trial-reset-apply': {
    summary: 'apply the exact owner-approved trial reset plan once',
    flags: ['dry-run'],
    values: ['plan', 'confirm-sha256'],
    required: ['plan', 'confirm-sha256'],
    run: (context, invocation) =>
      runTrialResetApply(
        context,
        invocation.values.plan!,
        invocation.values['confirm-sha256']!,
        invocation.dryRun,
      ),
  },
  'image-build': {
    summary: 'build the two-platform image bundle',
    flags: ['dry-run'],
    values: ['ref', 'out'],
    required: ['ref', 'out'],
    run: (context, invocation) =>
      runImageBuild(context, invocation.values.ref!, invocation.values.out!, invocation.dryRun),
  },
  'ses plan': { summary: 'preview SES provisioning', flags: [], run: runSesPlan },
  'ses configure': {
    summary: 'configure SES and DKIM',
    flags: ['dry-run'],
    run: (context, invocation) => runSesConfigure(context, invocation.dryRun),
  },
  'ses request-production': {
    summary: 'request SES production access',
    flags: ['dry-run'],
    run: (context, invocation) => runSesRequestProduction(context, invocation.dryRun),
  },
  'ses check': { summary: 'verify SES readiness', flags: [], run: runSesCheck },
  'dns plan': { summary: 'plan DNS migration', flags: [], run: (context) => runDnsPlan(context) },
  'dns import': {
    summary: 'import DNS records without deleting',
    flags: ['dry-run', 'update'],
    run: (context, invocation) =>
      runDnsPlan(context, { dryRun: invocation.dryRun, update: invocation.flags.has('update') }),
  },
  'dns verify': { summary: 'compare authoritative DNS answers', flags: [], run: runDnsVerify },
  'dns status': { summary: 'show delegation and domain status', flags: [], run: runDnsStatus },
  'dns switch': {
    summary: 'change registrar name servers',
    flags: ['dry-run', 'back'],
    run: (context, invocation) =>
      runDnsSwitch(context, { dryRun: invocation.dryRun, back: invocation.flags.has('back') }),
  },
  up: {
    summary: 'set up the cloud board',
    flags: ['dry-run'],
    values: ['login-json'],
    run: async (context, invocation) => {
      for (const command of ['preflight', 'aws', 'edge', 'deploy']) {
        context.report.line(`up: ${command}`);
        await COMMANDS[command]!.run(context, invocation);
      }
      const api = cloudflareApi(context, true);
      const account = await resolveAccount(api, context.config);
      const zone = await findZone(api, context.config, account.id);
      if (zone?.status !== 'active') {
        context.report.line(
          'Next: dns plan, dns import, dns verify, dns switch --dry-run, dns switch; dns status until active, then up again (docs/AWS.md)',
        );
        return;
      }
      context.report.line('up: publish');
      await COMMANDS.publish!.run(context, invocation);
      if (invocation.values['login-json'] && !invocation.dryRun) {
        context.report.line('up: check');
        await COMMANDS.check!.run(context, invocation);
      }
    },
  },
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
  edge: {
    summary: 'set up the Cloudflare side',
    flags: ['dry-run', 'rotate-engine-token', 'rotate-integrator-token'],
    run: (context, invocation) =>
      runEdge(context, {
        dryRun: invocation.dryRun,
        rotateEngineToken: invocation.flags.has('rotate-engine-token'),
        rotateIntegratorToken: invocation.flags.has('rotate-integrator-token'),
      }),
  },
  publish: {
    summary: 'make the board reachable',
    flags: ['dry-run', 'feedback'],
    run: (context, invocation) =>
      runPublish(context, { dryRun: invocation.dryRun, feedback: invocation.flags.has('feedback') }),
  },
  check: {
    summary: 'verify the public board',
    flags: [],
    values: ['login-json'],
    required: ['login-json'],
    run: (context, invocation) => runCheck(context, { loginJson: invocation.values['login-json']! }),
  },
};

interface Parsed {
  command: string;
  config: string | null;
  flags: Set<Flag>;
  values: Partial<Record<ValueOption, string>>;
}

function parse(argv: readonly string[]): Parsed {
  const [first, ...args] = argv;
  const grouped = first === 'dns' || first === 'ses';
  const command = grouped ? `${first} ${args[0] ?? ''}` : first;
  const rest = grouped ? args.slice(1) : args;
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
  if (command.startsWith('trial-reset-') && config === null)
    throw badUsage(`${command} needs --config\n${USAGE}`);
  if (
    command === 'image-build' &&
    (!sourceShaSchema.safeParse(values.ref).success || /[\0\r\n,]/.test(values.out!))
  )
    throw badUsage('image-build needs a SHA40 ref and an output path without NUL, newline or comma');
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
      flags: parsed.flags,
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
