import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { STRUCTURE_MAP_PATH, StructureMap } from '@projectman/shared';
import { coreBase } from './modules/core-base';
import { coreProjects } from './modules/core-projects';
import { coreTasks } from './modules/core-tasks';
import { coreMembers } from './modules/core-members';
import { coreTimeline } from './modules/core-timeline';
import { coreMessages } from './modules/core-messages';
import { coreInbox } from './modules/core-inbox';
import { coreMemberQueue } from './modules/core-member-queue';
import { coreAttachments } from './modules/core-attachments';

export type Layer =
  'contracts' | 'infra' | 'core' | 'runtime' | 'service' | 'engine' | 'connector' | 'assembly';

/** The one pass a module gets in the refactor (PM-577: no module is rewritten twice). */
export type Pass = 'none' | 'move' | 'split' | 'split-tool' | 'delete';

export interface ModuleEntry {
  /** Stable module id. */
  readonly id: string;
  readonly layer: Layer;
  /** Final folder or file under apps/server/src. */
  readonly target: string;
  readonly pass: Pass;
  /** Current files and folders relative to apps/server/src; folders end in '/'. */
  readonly paths: readonly string[];
  /** Other modules may import sealed modules only through their target/index.ts. */
  readonly sealed: boolean;
  /** Public entry files relative to target; default ['index.ts']. Sealed modules are imported only through these. */
  readonly entries?: readonly string[];
}

export interface DependencyException {
  readonly from: string;
  readonly to: string;
  /** Slice that removes this existing forbidden dependency. */
  readonly removedBy: string;
}

export const LAYER_RULES: Readonly<Record<Layer, readonly Layer[]>> = {
  contracts: ['contracts'],
  infra: ['contracts', 'infra'],
  core: ['contracts', 'infra', 'core'],
  runtime: ['contracts', 'infra', 'core', 'runtime'],
  service: ['contracts', 'infra', 'core'],
  engine: ['contracts', 'infra', 'engine'],
  connector: ['contracts', 'infra', 'core', 'runtime', 'service', 'connector'],
  assembly: ['contracts', 'infra', 'core', 'runtime', 'service', 'engine', 'connector', 'assembly'],
};

const structure = StructureMap.parse(
  parse(readFileSync(new URL(`../../../../${STRUCTURE_MAP_PATH}`, import.meta.url), 'utf8')),
);
const structureModules = new Map(structure.modules.map((module) => [module.id, module]));
const SERVER_SRC = 'apps/server/src/';

const definitions: readonly Omit<ModuleEntry, 'paths'>[] = [
  { id: 'exec', layer: 'infra', target: 'exec', pass: 'none', sealed: true },
  { id: 'services/web-push', layer: 'service', target: 'services/web-push', pass: 'none', sealed: true },
  {
    id: 'services/super-operator',
    layer: 'service',
    target: 'services/super-operator',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'services/structure',
    layer: 'service',
    target: 'services/structure',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'contracts',
    layer: 'contracts',
    target: 'contracts',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'db',
    layer: 'infra',
    target: 'db',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'config',
    layer: 'infra',
    target: 'config',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'logging',
    layer: 'infra',
    target: 'logging',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'instance',
    layer: 'infra',
    target: 'instance',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'kernel',
    layer: 'infra',
    target: 'kernel',
    pass: 'move',
    sealed: true,
    entries: ['index.ts', 'pure.ts'],
  },
  {
    id: 'agent-text',
    layer: 'infra',
    target: 'agent-text',
    pass: 'none',
    sealed: true,
  },
  coreBase,
  coreProjects,
  coreTasks,
  coreMembers,
  coreTimeline,
  coreMessages,
  coreInbox,
  coreMemberQueue,
  coreAttachments,
  {
    id: 'runtime/admission',
    layer: 'runtime',
    target: 'runtime/admission',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'runtime/sessions',
    layer: 'runtime',
    target: 'runtime/sessions',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'runtime/delivery',
    layer: 'runtime',
    target: 'runtime/delivery',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'runtime/member-queue',
    layer: 'runtime',
    target: 'runtime/member-queue',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'runtime/permissions',
    layer: 'runtime',
    target: 'runtime/permissions',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'runtime/watchers',
    layer: 'runtime',
    target: 'runtime/watchers',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'runtime/usage',
    layer: 'runtime',
    target: 'runtime/usage',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'context',
    layer: 'runtime',
    target: 'context',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'services/merges',
    layer: 'service',
    target: 'services/merges',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'services/full-tests',
    layer: 'service',
    target: 'services/full-tests',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'services/releases',
    layer: 'service',
    target: 'services/releases',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'services/github',
    layer: 'service',
    target: 'services/github',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'services/feedback',
    layer: 'service',
    target: 'services/feedback',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'services/project-docs',
    layer: 'service',
    target: 'services/project-docs',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'services/schedules',
    layer: 'service',
    target: 'services/schedules',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'services/obligations',
    layer: 'service',
    target: 'services/obligations',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'services/host-requests',
    layer: 'service',
    target: 'services/host-requests',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'services/email-login',
    layer: 'service',
    target: 'services/email-login',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'services/email-channel',
    layer: 'service',
    target: 'services/email-channel',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'services/history',
    layer: 'service',
    target: 'services/history',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'services/coordination',
    layer: 'service',
    target: 'services/coordination',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'runner',
    layer: 'engine',
    target: 'runner',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'worktree',
    layer: 'engine',
    target: 'worktree',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'engine-host',
    layer: 'engine',
    target: 'engine-host',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'full-test',
    layer: 'engine',
    target: 'full-test',
    pass: 'split-tool',
    sealed: true,
  },
  {
    id: 'machine',
    layer: 'engine',
    target: 'machine',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'engine-link',
    layer: 'engine',
    target: 'engine-link',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'history-semantic',
    layer: 'engine',
    target: 'history-semantic',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'api',
    layer: 'connector',
    target: 'api',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'mcp',
    layer: 'connector',
    target: 'mcp',
    pass: 'split',
    sealed: true,
  },
  {
    id: 'ws',
    layer: 'connector',
    target: 'ws',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'http',
    layer: 'connector',
    target: 'http',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'control',
    layer: 'connector',
    target: 'control',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'auth',
    layer: 'connector',
    target: 'auth',
    pass: 'none',
    sealed: true,
  },
  {
    id: 'assembly',
    layer: 'assembly',
    target: 'assembly.ts',
    pass: 'move',
    sealed: false,
  },
  {
    id: 'entry',
    layer: 'assembly',
    target: '.',
    pass: 'none',
    sealed: false,
  },
];

export const MODULES: readonly ModuleEntry[] = definitions.map((entry) => {
  const module = structureModules.get(entry.id);
  if (!module) throw new Error(`${entry.id}: missing from the structure map`);
  const paths = module.paths
    .filter((path) => path.startsWith(SERVER_SRC))
    .map((path) => path.slice(SERVER_SRC.length));
  if (paths.length === 0) throw new Error(`${entry.id}: no server source paths in the structure map`);
  return { ...entry, paths };
});

// No dependency exceptions remain. Never add new ones.
export const EXCEPTIONS: readonly DependencyException[] = [];
