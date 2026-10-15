import { coreBase } from './modules/core-base';
import { coreProjects } from './modules/core-projects';
import { coreTasks } from './modules/core-tasks';
import { coreMembers } from './modules/core-members';
import { coreTimeline } from './modules/core-timeline';
import { coreMessages } from './modules/core-messages';
import { coreInbox } from './modules/core-inbox';
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

export const MODULES: readonly ModuleEntry[] = [
  {
    id: 'services/structure',
    layer: 'service',
    target: 'services/structure',
    pass: 'none',
    paths: ['services/structure/'],
    sealed: true,
  },
  {
    id: 'contracts',
    layer: 'contracts',
    target: 'contracts',
    pass: 'none',
    paths: ['contracts/', 'contracts/operator-knowledge.ts'],
    sealed: true,
  },
  {
    id: 'db',
    layer: 'infra',
    target: 'db',
    pass: 'none',
    paths: ['db/', 'db/merge-trains.ts'],
    sealed: true,
  },
  {
    id: 'config',
    layer: 'infra',
    target: 'config',
    pass: 'none',
    paths: ['config/', 'config/operator-knowledge-store.ts'],
    sealed: true,
  },
  {
    id: 'logging',
    layer: 'infra',
    target: 'logging',
    pass: 'none',
    paths: ['logging/'],
    sealed: true,
  },
  {
    id: 'instance',
    layer: 'infra',
    target: 'instance',
    pass: 'none',
    paths: ['instance/'],
    sealed: true,
  },
  {
    id: 'kernel',
    layer: 'infra',
    target: 'kernel',
    pass: 'move',
    paths: ['kernel/'],
    sealed: true,
  },
  {
    id: 'agent-text',
    layer: 'infra',
    target: 'agent-text',
    pass: 'none',
    paths: ['agent-text/'],
    sealed: true,
  },
  coreBase,
  coreProjects,
  coreTasks,
  coreMembers,
  coreTimeline,
  coreMessages,
  coreInbox,
  coreAttachments,
  {
    id: 'runtime/admission',
    layer: 'runtime',
    target: 'runtime/admission',
    pass: 'split',
    paths: ['runtime/admission/'],
    sealed: true,
  },
  {
    id: 'runtime/sessions',
    layer: 'runtime',
    target: 'runtime/sessions',
    pass: 'split-tool',
    paths: ['runtime/sessions/'],
    sealed: true,
  },
  {
    id: 'runtime/delivery',
    layer: 'runtime',
    target: 'runtime/delivery',
    pass: 'split-tool',
    paths: ['runtime/delivery/'],
    sealed: true,
  },
  {
    id: 'runtime/permissions',
    layer: 'runtime',
    target: 'runtime/permissions',
    pass: 'split',
    paths: ['runtime/permissions/'],
    sealed: true,
  },
  {
    id: 'runtime/watchers',
    layer: 'runtime',
    target: 'runtime/watchers',
    pass: 'split-tool',
    paths: ['runtime/watchers/'],
    sealed: true,
  },
  {
    id: 'runtime/usage',
    layer: 'runtime',
    target: 'runtime/usage',
    pass: 'split-tool',
    paths: ['runtime/usage/'],
    sealed: true,
  },
  {
    id: 'context',
    layer: 'runtime',
    target: 'context',
    pass: 'split',
    paths: ['context/'],
    sealed: true,
  },
  {
    id: 'services/merges',
    layer: 'service',
    target: 'services/merges',
    pass: 'split-tool',
    paths: ['services/merges/', 'services/merges/train-selection.ts', 'services/merges/train.ts'],
    sealed: true,
  },
  {
    id: 'services/full-tests',
    layer: 'service',
    target: 'services/full-tests',
    pass: 'split-tool',
    paths: ['services/full-tests/'],
    sealed: true,
  },
  {
    id: 'services/releases',
    layer: 'service',
    target: 'services/releases',
    pass: 'split',
    paths: ['services/releases/'],
    sealed: true,
  },
  {
    id: 'services/github',
    layer: 'service',
    target: 'services/github',
    pass: 'split-tool',
    paths: ['services/github/'],
    sealed: true,
  },
  {
    id: 'services/feedback',
    layer: 'service',
    target: 'services/feedback',
    pass: 'split',
    paths: ['services/feedback/'],
    sealed: true,
  },
  {
    id: 'services/project-docs',
    layer: 'service',
    target: 'services/project-docs',
    pass: 'split-tool',
    paths: ['services/project-docs/'],
    sealed: true,
  },
  {
    id: 'services/boundary',
    layer: 'service',
    target: 'services/boundary',
    pass: 'split',
    paths: ['services/boundary/'],
    sealed: true,
  },
  {
    id: 'services/schedules',
    layer: 'service',
    target: 'services/schedules',
    pass: 'split-tool',
    paths: ['services/schedules/'],
    sealed: true,
  },
  {
    id: 'services/email-login',
    layer: 'service',
    target: 'services/email-login',
    pass: 'split',
    paths: ['services/email-login/'],
    sealed: true,
  },
  {
    id: 'services/operator',
    layer: 'service',
    target: 'services/operator',
    pass: 'split',
    paths: ['services/operator/', 'services/operator/preferences.ts'],
    sealed: true,
  },
  {
    id: 'runner',
    layer: 'engine',
    target: 'runner',
    pass: 'split-tool',
    paths: ['runner/'],
    sealed: true,
  },
  {
    id: 'worktree',
    layer: 'engine',
    target: 'worktree',
    pass: 'split-tool',
    paths: ['worktree/'],
    sealed: true,
  },
  {
    id: 'engine-host',
    layer: 'engine',
    target: 'engine-host',
    pass: 'split',
    paths: ['engine-host/'],
    sealed: true,
  },
  {
    id: 'full-test',
    layer: 'engine',
    target: 'full-test',
    pass: 'split-tool',
    paths: ['full-test/', 'full-test/npm-dependency-key.ts'],
    sealed: true,
  },
  {
    id: 'machine',
    layer: 'engine',
    target: 'machine',
    pass: 'split',
    paths: ['machine/'],
    sealed: true,
  },
  {
    id: 'engine-link',
    layer: 'engine',
    target: 'engine-link',
    pass: 'none',
    paths: ['engine-link/'],
    sealed: true,
  },
  {
    id: 'api',
    layer: 'connector',
    target: 'api',
    pass: 'none',
    paths: ['api/'],
    sealed: true,
  },
  {
    id: 'mcp',
    layer: 'connector',
    target: 'mcp',
    pass: 'split',
    paths: ['mcp/'],
    sealed: true,
  },
  {
    id: 'ws',
    layer: 'connector',
    target: 'ws',
    pass: 'none',
    paths: ['ws/'],
    sealed: true,
  },
  {
    id: 'http',
    layer: 'connector',
    target: 'http',
    pass: 'none',
    paths: ['http/'],
    sealed: true,
  },
  {
    id: 'control',
    layer: 'connector',
    target: 'control',
    pass: 'none',
    paths: ['control/'],
    sealed: true,
  },
  {
    id: 'auth',
    layer: 'connector',
    target: 'auth',
    pass: 'none',
    paths: ['auth/'],
    sealed: true,
  },
  {
    id: 'assembly',
    layer: 'assembly',
    target: 'assembly.ts',
    pass: 'move',
    paths: ['assembly.ts'],
    sealed: false,
  },
  {
    id: 'entry',
    layer: 'assembly',
    target: '.',
    pass: 'none',
    paths: ['app.ts', 'index.ts', 'engine-app.ts', 'shutdown.ts'],
    sealed: false,
  },
];

// No dependency exceptions remain. Never add new ones.
export const EXCEPTIONS: readonly DependencyException[] = [];
