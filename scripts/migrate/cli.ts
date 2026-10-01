// The move tool (PM-143): inventory, package, apply, verify, and who may work.
//
//   npx tsx scripts/migrate/cli.ts <command> [options]      (docs/MIGRATION.md has the procedure)
//
//   inventory --home H [--json FILE]           read-only facts and findings about a home and its work
//   package   --home H --out DIR               a secret package of a STOPPED source (never in a repository)
//   apply     --package DIR --target-home H --map FROM=TO ...   a standby copy on this machine
//   verify    --home H [--no-paths]            is the home whole and consistent (server stopped)
//   instance  status|standby|retire|activate --home H ...        who may work (only one copy is active)
//   work      list|apply --home H [--id N --into DIR]            the old machine's uncommitted work
//
// Exit status: 0 done, 1 refused or a blocking finding, 2 wrong usage.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyPackage, applyPendingWork, readPendingWork } from './apply';
import { activateHome, instanceStatus, retireHome, standbyHome } from './instance';
import { buildInventory, formatInventory } from './inventory';
import { createPackage, MigrationRefused } from './package';
import { parsePathMapping } from './paths';
import { formatVerify, verifyHome } from './verify';

interface Args {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(['no-paths', 'confirm-source-retired', 'json-only']);

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
    case 'package': {
      const { manifest, inventory } = await createPackage({ home: one(args, 'home'), out: one(args, 'out') });
      console.log(formatInventory(inventory));
      console.log(
        `\nPackage written to ${resolve(one(args, 'out'))}: ${Object.keys(manifest.files).length} files, ` +
          `${manifest.repos.length} repository bundles, ${manifest.work.length} pending work items, ` +
          `${manifest.transcripts.length} transcripts.\nIt is a SECRET: encrypt it before it leaves this machine; never put it in a repository, a task or a message.`,
      );
      return 0;
    }
    case 'apply': {
      const mappings = (args.flags.get('map') ?? []).map(parsePathMapping);
      const report = await applyPackage({ packageDir: one(args, 'package'), targetHome: one(args, 'target-home'), mappings });
      console.log(`Standby copy at ${report.targetHome}: schema ${report.schema.source} -> ${report.schema.target}.`);
      for (const r of report.reposRestored) console.log(`  repository ${r.project}/${r.name} at ${r.path} (${r.branches} branches)`);
      for (const c of report.configRewrites) console.log(`  workspace ${c.project}: ${c.from} -> ${c.to}`);
      console.log(`  ${report.pendingWork} pending work items, ${report.transcriptsCarried} transcripts, ${report.sessionsNotResumed} old conversations stay history`);
      for (const f of report.findings) console.log(`  ${f.severity.toUpperCase()} [${f.code}] ${f.subject}: ${f.message}`);
      const verified = await verifyHome({ home: report.targetHome, checkPaths: true });
      console.log(formatVerify(verified));
      return verified.ok ? 0 : 1;
    }
    case 'verify': {
      const result = await verifyHome({ home: one(args, 'home'), checkPaths: !args.flags.has('no-paths') });
      console.log(formatVerify(result));
      return result.ok ? 0 : 1;
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
        case 'activate':
          activateHome({ home, otherHome: optional(args, 'other-home'), confirmSourceRetired: args.flags.has('confirm-source-retired') });
          break;
        default:
          throw new UsageError('instance needs status, standby, retire or activate');
      }
      console.log(`${home}: ${instanceStatus(home)}`);
      return 0;
    }
    case 'work': {
      const home = one(args, 'home');
      if (sub === 'list') {
        for (const w of readPendingWork(home))
          console.log(
            `${w.id} ${w.state} ${w.kind} ${w.project}/${w.repo} ${w.sourcePath} @ ${w.head?.slice(0, 12) ?? '-'} ` +
              `(${w.files} files, ${w.deleted.length} deleted)${w.assignedTo ? ` for ${w.assignedTo.member}${w.assignedTo.taskKey ? ` ${w.assignedTo.taskKey}` : ''}` : ''}`,
          );
        return 0;
      }
      if (sub === 'apply') {
        const done = await applyPendingWork(home, one(args, 'id'), one(args, 'into'));
        console.log(`pending work ${done.id} applied into ${done.appliedInto}`);
        return 0;
      }
      throw new UsageError('work needs list or apply');
    }
    default:
      throw new UsageError('commands: inventory, package, apply, verify, instance, work');
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`usage error: ${error.message}\n(see the header of scripts/migrate/cli.ts and docs/MIGRATION.md)`);
      process.exit(2);
    }
    if (error instanceof MigrationRefused) {
      console.error(`REFUSED: ${error.message}`);
      for (const f of error.findings) console.error(`  ${f.severity.toUpperCase()} [${f.code}] ${f.subject}: ${f.message}`);
      process.exit(1);
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);
