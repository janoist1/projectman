import { z } from 'zod';
import { AgentEffort, AgentProvider, EngineId, LOCAL_PUBLISHING_OPERATIONS } from '@projectman/shared';
import type { AgentSandbox, SessionPolicy, StartSessionSpec } from '../contracts';

const text = z.string();
const texts = z.array(text);
const workspace = z.strictObject({ branch: text, baseCommit: text.nullable() });
const review = {
  sourceCommit: text,
  roundId: text,
  sourceBranch: text.optional(),
  baseBranch: text.optional(),
  baseCommit: text.optional(),
};
export const Policy: z.ZodType<SessionPolicy> = z.strictObject({
  version: z.literal(1),
  enforcement: z.enum(['legacy', 'strict']),
  execution: z
    .strictObject({
      profile: z.literal('managed_vm'),
      boundary: z.strictObject({ name: text, version: z.number() }),
    })
    .optional(),
  access: z.enum(['task_worktree', 'review_copy', 'read_only', 'member_workspace']),
  reviewCopyMode: z.enum(['inherit', 'read_only', 'test']).optional(),
  placement: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('task_worktree'),
      mergeFix: z.strictObject({ branch: text }).optional(),
      path: text,
      gitDir: text.optional(),
      worktreeGitDir: text.optional(),
      workspace: workspace.optional(),
    }),
    z.strictObject({
      kind: z.literal('review_copy'),
      path: text,
      gitDir: text,
      ...review,
      cacheDir: text.optional(),
      tempDir: text.optional(),
    }),
    z.strictObject({ kind: z.literal('read_only'), path: text }),
    z.strictObject({
      kind: z.literal('member_workspace'),
      path: text,
      use: z.enum(['work', 'review', 'home']),
      workspace: workspace.optional(),
      review: z.strictObject(review).optional(),
    }),
  ]),
  tools: z.strictObject({
    team: z.strictObject({ all: z.boolean(), names: texts }),
    files: z.array(z.enum(['read', 'grep', 'glob'])),
    shell: z.array(z.strictObject({ command: text, arguments: z.enum(['exact', 'prefix']) })),
  }),
  filesystem: z.strictObject({
    readableRoots: texts,
    writableRoots: texts,
    protectedPaths: texts,
    readOnlyPaths: texts.optional(),
    deniedPaths: texts.optional(),
    sessionFolder: text.optional(),
    sessionFoldersRoot: text.optional(),
  }),
  deniedOperations: z.array(z.enum(LOCAL_PUBLISHING_OPERATIONS)),
  network: z.strictObject({
    allowedDomains: texts,
    allowLocalBinding: z.boolean(),
    deniedHosts: texts.optional(),
    outbound: z.enum(['open', 'allowlist']).optional(),
  }),
  outsideSandbox: z.enum(['ask', 'deny']),
  permissions: z.strictObject({
    claude: z.enum(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
    approval: z.enum(['never', 'on-request']),
  }),
});
export const Sandbox: z.ZodType<AgentSandbox> = z.strictObject({
  allowWrite: texts,
  allowedDomains: texts,
  deniedDomains: texts.optional(),
  allowLocalBinding: z.boolean(),
  denyWrite: texts.optional(),
  denyRead: texts.optional(),
  allowRead: texts.optional(),
  deniedEnvVars: texts.optional(),
  env: z.record(text, text).optional(),
  excludedCommands: texts.optional(),
  portable: z
    .strictObject({ allowWrite: texts, env: z.record(text, text), tmpDir: text.optional() })
    .optional(),
});
export type EngineStartSpec = Omit<StartSessionSpec, 'mcpUrl'> & { mcpToken: string };
export const EngineStartSpec: z.ZodType<EngineStartSpec> = z.strictObject({
  sessionId: text,
  engineId: EngineId.optional(),
  claudeSessionId: text,
  resume: z.boolean(),
  cwd: text,
  displayName: text,
  model: text.optional(),
  effort: AgentEffort.optional(),
  autoCompactWindowTokens: z.number().optional(),
  permissionMode: text.optional(),
  appendSystemPrompt: text,
  subagents: z
    .array(z.strictObject({ name: text, description: text, prompt: text, tools: texts, model: text }))
    .optional(),
  initialMessage: text.nullable().optional(),
  compactFirst: text.optional(),
  firstUserOrigin: z.enum(['brief', 'human']).optional(),
  mcpToken: text,
  policy: Policy.optional(),
  allowedTools: texts,
  deniedTools: texts.optional(),
  additionalDirectories: texts.optional(),
  writableRoots: texts.optional(),
  sandbox: Sandbox.optional(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  member: text.optional(),
  provider: AgentProvider.optional(),
  egressToken: text.optional(),
});
