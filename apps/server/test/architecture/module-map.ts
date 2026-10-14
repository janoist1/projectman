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
    id: 'contracts',
    layer: 'contracts',
    target: 'contracts',
    pass: 'none',
    paths: ['contracts/'],
    sealed: false,
  },
  {
    id: 'db',
    layer: 'infra',
    target: 'db',
    pass: 'none',
    paths: ['db/'],
    sealed: false,
  },
  {
    id: 'config',
    layer: 'infra',
    target: 'config',
    pass: 'none',
    paths: ['config/'],
    sealed: false,
  },
  {
    id: 'logging',
    layer: 'infra',
    target: 'logging',
    pass: 'none',
    paths: ['logging/'],
    sealed: false,
  },
  {
    id: 'instance',
    layer: 'infra',
    target: 'instance',
    pass: 'none',
    paths: ['instance/'],
    sealed: false,
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
    sealed: false,
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
    sealed: false,
  },
  {
    id: 'services/merges',
    layer: 'service',
    target: 'services/merges',
    pass: 'split-tool',
    paths: ['services/merges/'],
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
    id: 'services/operator',
    layer: 'service',
    target: 'services/operator',
    pass: 'split',
    paths: ['services/operator/'],
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
    paths: ['full-test/'],
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
    sealed: false,
  },
  {
    id: 'api',
    layer: 'connector',
    target: 'api',
    pass: 'none',
    paths: ['api/'],
    sealed: false,
  },
  {
    id: 'mcp',
    layer: 'connector',
    target: 'mcp',
    pass: 'split',
    paths: ['mcp/'],
    sealed: false,
  },
  {
    id: 'ws',
    layer: 'connector',
    target: 'ws',
    pass: 'none',
    paths: ['ws/'],
    sealed: false,
  },
  {
    id: 'http',
    layer: 'connector',
    target: 'http',
    pass: 'none',
    paths: ['http/'],
    sealed: false,
  },
  {
    id: 'control',
    layer: 'connector',
    target: 'control',
    pass: 'none',
    paths: ['control/'],
    sealed: false,
  },
  {
    id: 'auth',
    layer: 'connector',
    target: 'auth',
    pass: 'none',
    paths: ['auth/'],
    sealed: false,
  },
  {
    id: 'assembly',
    layer: 'assembly',
    target: 'assembly.ts',
    pass: 'move',
    paths: ['domain/index.ts'],
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

// Initial baseline only. Slice cards remove exceptions; never add new ones.
export const EXCEPTIONS: readonly DependencyException[] = [
  { from: 'api', to: 'assembly', removedBy: 'api' },
  {
    from: 'auth',
    to: 'assembly',
    removedBy: 'auth',
  },
  {
    from: 'core/inbox',
    to: 'runtime/sessions',
    removedBy: 'core/inbox',
  },
  {
    from: 'core/inbox',
    to: 'runtime/admission',
    removedBy: 'core/inbox',
  },
  {
    from: 'core/members',
    to: 'auth',
    removedBy: 'core/members',
  },
  {
    from: 'core/members',
    to: 'runtime/admission',
    removedBy: 'core/members',
  },
  {
    from: 'core/members',
    to: 'runtime/sessions',
    removedBy: 'core/members',
  },
  {
    from: 'core/messages',
    to: 'runtime/delivery',
    removedBy: 'core/messages',
  },
  {
    from: 'core/messages',
    to: 'services/operator',
    removedBy: 'core/messages',
  },
  {
    from: 'core/messages',
    to: 'runtime/admission',
    removedBy: 'core/messages',
  },
  {
    from: 'core/messages',
    to: 'runtime/sessions',
    removedBy: 'core/messages',
  },
  {
    from: 'instance',
    to: 'entry',
    removedBy: 'instance',
  },
  {
    from: 'ws',
    to: 'assembly',
    removedBy: 'ws',
  },
];
