import { posix } from 'node:path';
import type { Inventory, RepoInventory } from './inventory';
import { isDirty } from './inventory';
import type { PathMapping } from './paths';

/**
 * The concrete move for one real home, written out (PM-143): the path mappings the inventory suggests,
 * the decisions only a person can take (the owner's own unpushed and uncommitted work), the exact
 * commands, and what is not carried. It reads the inventory only, so it is safe to run on a running
 * source; the output is what the owner approves or changes, and it names facts, never file contents.
 */

export interface PlanOptions {
  /** Where the VM keeps the project repositories (the new workspace paths), e.g. /var/lib/projectman/repos. */
  vmRepoRoot: string;
  /** PROJECTMAN_HOME on the VM. */
  vmHome: string;
  /** Where the package is written on the old machine and where it lies on the VM. */
  packageDirOld: string;
  packageDirVm: string;
}

export interface SuggestedMappings {
  mappings: PathMapping[];
  notes: string[];
}

/** One mapping per project workspace (repositories under it follow), more for a repository outside it. */
export function suggestMappings(inventory: Inventory, vmRepoRoot: string): SuggestedMappings {
  const mappings: PathMapping[] = [];
  const notes: string[] = [];
  const taken = new Set<string>();
  const add = (from: string, to: string, why: string) => {
    if (taken.has(from)) {
      notes.push(`${from} is shared (${why}): it keeps the first target`);
      return;
    }
    taken.add(from);
    mappings.push({ from, to });
  };
  for (const project of inventory.projects) {
    add(project.workspacePath, posix.join(vmRepoRoot, project.key), `workspace of ${project.key}`);
    for (const repo of project.repos) {
      const inside = repo.path === project.workspacePath || repo.path.startsWith(`${project.workspacePath}/`);
      if (!inside)
        add(
          repo.path,
          posix.join(vmRepoRoot, `${project.key}-${repo.name}`),
          `repository ${repo.name} outside its workspace`,
        );
    }
  }
  return { mappings, notes };
}

const flat = (repo: RepoInventory) => (repo.isGit ? repo : null);

export function renderCutoverSheet(inventory: Inventory, options: PlanOptions): string {
  const { mappings, notes } = suggestMappings(inventory, options.vmRepoRoot);
  const out: string[] = [];
  const blockers = inventory.findings.filter((f) => f.severity === 'blocker');
  const warnings = inventory.findings.filter((f) => f.severity === 'warning');
  out.push(`# Cutover sheet: ${inventory.home} -> the VM`);
  out.push('');
  out.push(
    `Made ${inventory.createdAt} from the inventory of ${inventory.home} (schema ${inventory.database.schemaVersion ?? '-'}, this build ${inventory.database.buildSchemaVersion}). It is a proposal: nothing here has been done, and approving the move is a separate decision.`,
  );
  out.push('');
  out.push('## What moves');
  out.push('');
  const c = inventory.database.counts;
  out.push(
    `- Database: ${c.tasks ?? 0} tasks, ${c.timeline_events ?? 0} timeline events, ${c.sessions ?? 0} conversations, ${c.users ?? 0} accounts, ${inventory.database.openInbox} open inbox items, ${inventory.database.deferredStarts} deferred starts.`,
  );
  out.push(
    `- Cookie secret: ${inventory.secret.present ? 'present (browser logins stay valid)' : '**MISSING**'}; customization repository (history included): ${inventory.customization.present ? `head ${inventory.customization.head?.slice(0, 12) ?? '-'}` : '**missing**'}.`,
  );
  out.push(
    `- Attachments: ${inventory.attachments.rows} (${inventory.attachments.bytes} bytes); member memory: ${inventory.memory.files} files; transcripts: ${inventory.sessions.transcripts.present} of ${inventory.sessions.transcripts.referenced} present.`,
  );
  out.push(
    `- Not carried, on purpose: ${
      inventory.entries
        .filter((e) => ['worktrees', 'workspaces', 'github-publish'].includes(e.name))
        .map((e) => e.name)
        .join(', ') || 'nothing of that kind'
    } (old worktrees stay where they are and are never deleted by the move), the personal CLI homes of the Mac, the publishing identity.`,
  );
  out.push('');
  out.push('## Path mappings');
  out.push('');
  if (mappings.length === 0) out.push('No project names a workspace: nothing to map.');
  else {
    out.push('| Old path (this machine) | New path (VM) |');
    out.push('| --- | --- |');
    for (const m of mappings) out.push(`| \`${m.from}\` | \`${m.to}\` |`);
  }
  for (const note of notes) out.push(`\n- ${note}`);
  out.push(
    `\nThe old home (\`${inventory.home}\`) maps onto \`${options.vmHome}\` by itself. Every other absolute path stored in the data (${inventory.absolutePaths.map((g) => `\`${g.group}\``).join(', ') || 'none'}) stays as it was, as history, and is listed in the apply report.`,
  );
  out.push('');
  out.push('## Decisions for the owner');
  out.push('');
  const decisions: string[] = [];
  for (const project of inventory.projects) {
    for (const repo of project.repos.map(flat).filter((r): r is RepoInventory => r !== null)) {
      const label = `${project.key}/${repo.name}`;
      if (isDirty(repo.dirty))
        decisions.push(
          `**${label}, main checkout** (\`${repo.path}\`): ${repo.dirty.modified + repo.dirty.deleted} changed, ${repo.dirty.untracked} untracked files. Recommended: commit what is finished before the stop; whatever is left travels as pending work, assigned by a person on the VM.`,
        );
      for (const w of repo.worktrees)
        if (isDirty(w.dirty))
          decisions.push(
            `**${label}, worktree \`${w.path}\`** (${w.branch ?? 'detached'}${w.assignedTo ? `, ${w.assignedTo.member}${w.assignedTo.taskKey ? ` on ${w.assignedTo.taskKey}` : ''}` : ''}): ${w.dirty.modified + w.dirty.deleted} changed, ${w.dirty.untracked} untracked files. Carried as pending work for ${w.assignedTo?.member ?? 'a member a person names'}; never discarded, never stashed.`,
          );
      const local = repo.branches.filter((b) => b.localOnlyCommits > 0);
      if (repo.remotes.length === 0 && repo.head)
        decisions.push(
          `**${label}** has no remote: its commits exist only on this machine. The bundle in the package is then the only copy that moves; keep the old repository until the VM has pushed it somewhere.`,
        );
      else if (local.length > 0)
        decisions.push(
          `**${label}**: ${local.length} branches hold commits on no remote (${local.map((b) => `${b.name}: ${b.localOnlyCommits}`).join(', ')}). They travel in the bundle. Recommended: push them first.`,
        );
    }
  }
  if (inventory.database.liveSessions > 0)
    decisions.push(
      `${inventory.database.liveSessions} conversations are recorded as running: stop the live instance cleanly first (they are history after the move; no old conversation is resumed on the VM).`,
    );
  if (decisions.length === 0) out.push('None: no unpushed or uncommitted work was found.');
  else decisions.forEach((d, i) => out.push(`${i + 1}. ${d}`));
  out.push('');
  out.push('## Blocking findings');
  out.push('');
  if (blockers.length === 0) out.push('None.');
  else for (const f of blockers) out.push(`- [${f.code}] ${f.subject}: ${f.message}`);
  if (warnings.length > 0) {
    out.push('');
    out.push('Warnings (do not block, listed so nothing is a surprise):');
    for (const f of warnings) out.push(`- [${f.code}] ${f.subject}: ${f.message}`);
  }
  out.push('');
  out.push('## Commands');
  out.push('');
  const maps = mappings.map((m) => `--map ${m.from}=${m.to}`).join(' \\\n    ');
  out.push(
    'On this machine, with the live instance **stopped**, from a clean checkout of the deployed commit:',
  );
  out.push('');
  out.push('```sh');
  out.push(`npm run migrate -- inventory --home ${inventory.home}`);
  out.push(`npm run migrate -- package --home ${inventory.home} --out ${options.packageDirOld}`);
  out.push('```');
  out.push('');
  out.push(
    `Encrypt \`${options.packageDirOld}\` before it leaves this machine and put it on the VM under \`${posix.dirname(options.packageDirVm)}\` (mode 0700, owned by \`projectman\`). On the VM, with the service stopped and the old data moved aside, never deleted:`,
  );
  out.push('');
  out.push('```sh');
  out.push(
    `sudo bash /srv/projectman/deploy/vm/migrate.sh apply --package ${options.packageDirVm} \\\n    --target-home ${options.vmHome} \\\n    ${maps}`.trimEnd(),
  );
  out.push(`sudo bash /srv/projectman/deploy/vm/migrate.sh verify --home ${options.vmHome}`);
  out.push('```');
  out.push('');
  out.push(
    'The rest of the procedure (checks in the browser and on the phone, retiring this machine, activating the VM, the rollback) is `docs/MIGRATION.md`.',
  );
  return `${out.join('\n')}\n`;
}
