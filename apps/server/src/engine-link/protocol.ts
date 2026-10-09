import { z } from 'zod';
import {
  AgentProvider,
  ChatItem,
  EngineId,
  EngineProvider,
  MAX_ATTACHMENT_BYTES,
  PausePoint,
  SessionState,
  TokenUsage,
} from '@projectman/shared';
import type { EnginePaths, PermissionRefusedInfo, RunnerEvent, RunningSessionInfo } from '../contracts';
import type { PullRequestInfo } from '../contracts/github';

export const ENGINE_PROTOCOL_VERSION = 1;
export const ENGINE_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const ENGINE_HEARTBEAT_MS = 20_000;
export const ENGINE_DEAD_AFTER_MS = 45_000;
export const ENGINE_OFFLINE_AFTER_MS = 120_000;
export const ENGINE_RELAY_WAIT_MS = 60_000;
export const ENGINE_UPLOAD_MAX_BYTES = {
  file: MAX_ATTACHMENT_BYTES,
  transcript: 64 * 1024 * 1024,
  bundle: 512 * 1024 * 1024,
} as const;
export const EngineUploadPurpose = z.enum(['file', 'transcript', 'bundle']);
export type EngineUploadPurpose = z.infer<typeof EngineUploadPurpose>;
export const EngineUploaded = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});
export type EngineUploaded = z.infer<typeof EngineUploaded>;

const text = z.string();
const int = z.number().int().nonnegative();
const seq = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const RequestId = text.regex(/^[A-Za-z0-9_-]{1,64}$/);
export const Paths: z.ZodType<EnginePaths> = z.strictObject({
  userHome: text,
  home: text.nullable(),
  worktreesRoot: text.nullable(),
  workspacesRoot: text.nullable(),
  installDir: text.nullable(),
  sessionFoldersRoot: text.nullable(),
  sessionTmpRoot: text.nullable(),
  claudeTmpRoots: z.array(text),
  browsersDir: text.nullable(),
  heavyLockDir: text.nullable(),
  gitExcludesFile: text.nullable(),
});
export const RunningSession: z.ZodType<RunningSessionInfo> = z.strictObject({
  sessionId: text,
  pid: int,
  state: SessionState,
  cols: int,
  rows: int,
});
export const PullRequest: z.ZodType<PullRequestInfo> = z.strictObject({
  repo: text,
  number: int,
  title: text,
  url: text,
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  headRef: text,
  baseRef: text,
  checks: z.enum(['success', 'failure', 'pending', 'none']),
  reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
  additions: int,
  deletions: int,
  changedFiles: int,
  updatedAt: text,
  authorLogin: text.optional(),
  headSha: text.optional(),
});
export const RefusedInfo: z.ZodType<PermissionRefusedInfo> = z.strictObject({
  sessionId: text,
  toolName: text,
  toolInput: z.unknown(),
  reason: text.optional(),
});
export const WireRunnerEvent: z.ZodType<Exclude<RunnerEvent, { type: 'terminal_data' }>> =
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('rate_limited'),
      sessionId: text,
      provider: AgentProvider,
      message: text,
      at: text,
    }),
    z.strictObject({
      type: z.literal('state'),
      sessionId: text,
      state: SessionState,
      activity: text.nullable(),
    }),
    z.strictObject({ type: z.literal('transcript_path'), sessionId: text, path: text }),
    z.strictObject({ type: z.literal('chat'), sessionId: text, items: z.array(ChatItem) }),
    z.strictObject({
      type: z.literal('exit'),
      sessionId: text,
      exitCode: z.number().int().nullable(),
      signal: z.number().int().nullable(),
    }),
    z.strictObject({ type: z.literal('first_input_sent'), sessionId: text }),
    z.strictObject({ type: z.literal('provider_session_id'), sessionId: text, providerSessionId: text }),
    z.strictObject({
      type: z.literal('auth_error'),
      sessionId: text,
      provider: AgentProvider,
      message: text,
    }),
    z.strictObject({
      type: z.literal('usage'),
      sessionId: text,
      entries: z.array(TokenUsage),
      contextTokens: int.optional(),
    }),
    z.strictObject({
      type: z.literal('compaction'),
      sessionId: text,
      phase: z.enum(['started', 'finished', 'abandoned']),
      trigger: text.nullable(),
      requested: z.boolean(),
    }),
    z.strictObject({ type: z.literal('session_pausing'), sessionId: text, waitingFor: text.nullable() }),
    z.strictObject({
      type: z.literal('session_paused'),
      sessionId: text,
      point: PausePoint,
      tool: text.nullable(),
    }),
  ]);
export const EngineEvent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('runner'), event: WireRunnerEvent }),
  z.strictObject({ kind: z.literal('pending_input'), sessionId: text, pending: z.boolean() }),
  z.strictObject({ kind: z.literal('refused'), info: RefusedInfo }),
  z.strictObject({ kind: z.literal('github_changed'), watchId: text, change: PullRequest }),
  z.strictObject({ kind: z.literal('screenshot_started'), runId: text }),
]);
export type EngineEvent = z.infer<typeof EngineEvent>;
export const Hello = z.strictObject({
  t: z.literal('hello'),
  protocol: z.number().int(),
  version: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/),
  hostname: text,
  platform: z.enum(['darwin', 'linux']),
  paths: Paths,
  projects: z.array(z.strictObject({ project: text, workspacePath: text })),
  repos: z.array(z.strictObject({ project: text, repo: text, fullTest: z.boolean() })),
  providers: z.array(EngineProvider),
  running: z.array(RunningSession),
  nextSeq: seq,
  instanceTag: text.regex(/^[a-f0-9]{16}$/),
  pid: int.min(1),
  uid: int.nullable(),
  bootId: text.regex(/^[a-f0-9]{16}$/),
});
export type Hello = z.infer<typeof Hello>;
export const EngineErrorCode = z.enum([
  'invalid_params',
  'unknown_method',
  'not_running',
  'path_outside_roots',
  'permission_mode_too_high',
  'command_not_allowed',
  'terminal_input_disabled',
  'repo_not_registered',
  'signal_not_allowed',
  'secret_not_allowed',
  'link_down',
  'timeout',
  'internal',
  'module_error',
  'result_too_large',
]);
export type EngineErrorCode = z.infer<typeof EngineErrorCode>;
export const EngineWireError = z
  .strictObject({
    code: EngineErrorCode,
    message: text.max(2000),
    module: z
      .strictObject({
        code: text.regex(/^[a-z][a-z0-9_]{0,63}$/),
        details: z.record(text, z.unknown()).optional(),
      })
      .optional(),
  })
  .refine((error) => (error.code === 'module_error') === (error.module !== undefined), {
    message: 'Module metadata requires module_error',
  });
export type EngineWireError = z.infer<typeof EngineWireError>;
export const RequestFrame = z.strictObject({
  t: z.literal('req'),
  id: RequestId,
  method: text,
  params: z.unknown(),
});
export const ResponseFrame = z.discriminatedUnion('ok', [
  z.strictObject({ t: z.literal('res'), id: RequestId, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ t: z.literal('res'), id: RequestId, ok: z.literal(false), error: EngineWireError }),
]);
export type ResponseFrame = z.infer<typeof ResponseFrame>;
export const EngineFrame = z.discriminatedUnion('t', [
  Hello,
  z.strictObject({
    t: z.literal('welcome'),
    engineId: EngineId,
    ackedSeq: int.max(Number.MAX_SAFE_INTEGER),
    serverTime: text,
  }),
  z.strictObject({
    t: z.literal('refuse'),
    code: z.enum(['protocol_mismatch', 'engine_revoked', 'engine_replaced']),
    message: text,
  }),
  RequestFrame,
  ResponseFrame,
  z.strictObject({ t: z.literal('evt'), seq, event: EngineEvent }),
  z.strictObject({ t: z.literal('ack'), seq: int.max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ t: z.literal('term'), sessionId: text, data: text }),
]);
export type EngineFrame = z.infer<typeof EngineFrame>;

export function encodeFrame(frame: EngineFrame): string {
  const encoded = JSON.stringify(EngineFrame.parse(frame));
  if (Buffer.byteLength(encoded) > ENGINE_MAX_FRAME_BYTES) throw new Error('Engine frame too large');
  return encoded;
}
export function decodeFrame(data: string | Buffer): EngineFrame {
  if (Buffer.byteLength(data) > ENGINE_MAX_FRAME_BYTES) throw new Error('Engine frame too large');
  return EngineFrame.parse(JSON.parse(data.toString()));
}
