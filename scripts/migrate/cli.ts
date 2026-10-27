// The move tool: hybrid migration, inventory, verification, and instance roles.
//
//   npx tsx scripts/migrate/cli.ts <command> [options]      (docs/HYBRID.md has the procedure)
//
//   inventory --home H [--json FILE]           read-only facts and findings about a home and its work
//   verify    --home H [--no-paths|--hybrid-cloud]   is the home whole and consistent (server stopped)
//   instance  status|standby|retire|engine|activate --home H ...  who may work (only one copy is active)
//   hybrid    plan --home H                      the hybrid mode (PM-318, docs/HYBRID.md): what goes to the cloud (read-only)
//   hybrid    package --home H --out DIR --engine-name N --cloud URL   the cloud's package of a STOPPED home; writes engine.key and engine.json in H
//   hybrid    back --home H --from DIR --confirm-source-retired        the cloud's data replaces the Mac's home (the old entries are kept)
//
// Exit status: 0 done, 1 refused or a blocking finding, 2 wrong usage.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildHybridPlan, createHybridPackage, hybridBack, renderHybridPlan } from './hybrid';
import { activateHome, engineHome, instanceStatus, retireHome, standbyHome } from './instance';
import { buildInventory, formatInventory } from './inventory';
import { MigrationRefused } from './package';
import { formatVerify, verifyHome } from './verify';

interface Args {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set([
  'no-paths',
  'confirm-source-retired',
  'json-only',
  'hybrid-cloud',
  'discard-cloud-data',
]);

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
    case 'inventory': {
      const inventory = await buildInventory({ home: one(args, 'home') });
      const json = optional(args, 'json');
      if (json) {
        mkdirSync(dirname(resolve(json)), { recursive: true });
        writeFileSync(resolve(json), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
      }
      console.log(formatInventory(inventory));
      return inventory.findings.some((f) => f.severity === 'blocker') ? 1 : 0;
    }
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
        case 'plan':
          console.log(renderHybridPlan(await buildHybridPlan({ home })));
          return 0;
        case 'package': {
          const out = resolve(one(args, 'out'));
          const result = await createHybridPackage({
            home,
            out,
            engineName: one(args, 'engine-name'),
            cloudUrl: one(args, 'cloud'),
          });
          console.log(
            `Cloud package written to ${out}/home (${Object.keys(result.manifest.files).length} files); ` +
              `engine ${result.engine.id} "${result.engine.name}", ${result.sessionsMoved} sessions moved to it.\n` +
              `Written in ${home}: ${result.keyFile} (the machine key, mode 600, shown nowhere) and ${result.configFile}.`,
          );
          for (const warning of result.warnings) console.log(`  WARNING ${warning}`);
          console.log(
            'The package is a SECRET (the database, the cookie key): upload only home/ to the cloud volume, never put it in a repository, a task or a message.',
          );
          return 0;
        }
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
          throw new UsageError('hybrid needs plan, package or back');
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
      throw new UsageError('commands: inventory, verify, instance, hybrid');
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
