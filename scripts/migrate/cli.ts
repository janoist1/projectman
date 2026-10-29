// The move tool: the way back from the hybrid mode, verification, and instance roles.
//
//   npx tsx scripts/migrate/cli.ts <command> [options]      (docs/HYBRID.md has the procedure)
//
//   verify    --home H [--no-paths|--hybrid-cloud]   is the home whole and consistent (server stopped)
//   instance  status|standby|retire|engine|activate --home H ...  who may work (only one copy is active)
//   hybrid    back --home H --from DIR --confirm-source-retired        the cloud's data replaces the Mac's home (the old entries are kept)
//
// The one-off commands that moved a home to the cloud (`inventory`, `hybrid plan`, `hybrid package`) were
// retired with the cutover (PM-1116); the last commit that has them is tagged `retired-migrate-dns`. Their
// functions stay in hybrid.ts and inventory.ts: the tests build their cloud data with them.
// Exit status: 0 done, 1 refused or a blocking finding, 2 wrong usage.
import { hybridBack } from './hybrid';
import { activateHome, engineHome, instanceStatus, retireHome, standbyHome } from './instance';
import { MigrationRefused } from './package';
import { formatVerify, verifyHome } from './verify';

interface Args {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(['no-paths', 'confirm-source-retired', 'hybrid-cloud', 'discard-cloud-data']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) flags.set(name, ['true']);
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      flags.set(name, [...(flags.get(name) ?? []), value]);
      i += 1;
    }
  }
  return { positional, flags };
}

class UsageError extends Error {}

const one = (args: Args, name: string): string => {
  const values = args.flags.get(name);
  if (!values || values.length !== 1) throw new UsageError(`--${name} is required (once)`);
  return values[0]!;
};
const optional = (args: Args, name: string): string | undefined => args.flags.get(name)?.[0];

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [command, sub] = args.positional;
  switch (command) {
    case 'verify': {
      const result = await verifyHome({
        home: one(args, 'home'),
        checkPaths: !args.flags.has('no-paths'),
        hybridCloud: args.flags.has('hybrid-cloud'),
      });
      console.log(formatVerify(result));
      return result.ok ? 0 : 1;
    }
    case 'hybrid': {
      const home = one(args, 'home');
      switch (sub) {
        case 'back': {
          const report = await hybridBack({
            home,
            from: one(args, 'from'),
            confirmCloudStopped: args.flags.has('confirm-source-retired'),
          });
          console.log(
            `${home}: the cloud's data is in place; engine ${report.engineId} is revoked, ${report.sessionsMoved} sessions are local again ` +
              `(${report.liveSessions} were not closed: the first start resumes or ends them).\n` +
              `The former entries are in ${report.archive}. Next: instance activate --home ${home} --confirm-source-retired`,
          );
          return 0;
        }
        default:
          throw new UsageError('hybrid needs back');
      }
    }
    case 'instance': {
      const home = one(args, 'home');
      switch (sub) {
        case 'status':
          console.log(instanceStatus(home));
          return 0;
        case 'standby':
          standbyHome(home, one(args, 'reason'));
          break;
        case 'retire':
          retireHome(home, one(args, 'reason'));
          break;
        case 'engine':
          engineHome(home, optional(args, 'reason') ?? 'hybrid mode: this machine runs the engine only');
          break;
        case 'activate':
          activateHome({
            home,
            otherHome: optional(args, 'other-home'),
            confirmSourceRetired: args.flags.has('confirm-source-retired'),
            discardCloudData: args.flags.has('discard-cloud-data'),
          });
          break;
        default:
          throw new UsageError('instance needs status, standby, retire, engine or activate');
      }
      console.log(`${home}: ${instanceStatus(home)}`);
      return 0;
    }
    default:
      throw new UsageError('commands: verify, instance, hybrid');
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(
        `usage error: ${error.message}\n(see the header of scripts/migrate/cli.ts and docs/HYBRID.md)`,
      );
      process.exit(2);
    }
    if (error instanceof MigrationRefused) {
      console.error(`REFUSED: ${error.message}`);
      for (const f of error.findings)
        console.error(`  ${f.severity.toUpperCase()} [${f.code}] ${f.subject}: ${f.message}`);
      process.exit(1);
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
