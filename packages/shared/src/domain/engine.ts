import { z } from 'zod';
import { AgentProvider } from './member';

/** The engine of a single-machine installation: the machine the server itself runs on. */
export const LOCAL_ENGINE_ID = 'local';

/**
 * Which engine (the machine the AI sessions run on, PM-311) something belongs to: `local`, or the id
 * of a registered engine. A session without one (a row from before engines) ran on `local`.
 */
export const EngineId = z.string().regex(/^(local|eng_[a-z0-9]{12})$/);
export type EngineId = z.infer<typeof EngineId>;

export const EngineStatusView = z.object({
  id: EngineId,
  name: z.string(),
  isDefault: z.boolean(),
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
});
export type EngineStatusView = z.infer<typeof EngineStatusView>;
export const EngineProvider = z.strictObject({
  provider: AgentProvider,
  available: z.boolean(),
  version: z.string().nullable(),
});
export const EngineView = EngineStatusView.extend({
  keyPrefix: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  revokedAt: z.string().nullable(),
  lastSeenIp: z.string().nullable(),
  hostname: z.string().nullable(),
  platform: z.enum(['darwin', 'linux']).nullable(),
  version: z.string().nullable(),
  versionMismatch: z.boolean(),
  providers: z.array(EngineProvider),
  runningSessions: z.number().int(),
  waitingStarts: z.number().int(),
  waitingMessages: z.number().int(),
});
export type EngineView = z.infer<typeof EngineView>;
export const EngineStatusResponse = z.object({
  mode: z.enum(['single', 'cloud']),
  engines: z.array(EngineStatusView),
});
export type EngineStatusResponse = z.infer<typeof EngineStatusResponse>;
export const CreateEngineRequest = z.strictObject({ name: z.string().trim().min(1).max(64) });
export const CreateEngineResponse = z.object({ engine: EngineView, key: z.string() });
export type CreateEngineResponse = z.infer<typeof CreateEngineResponse>;

/** One engine of a project as a member sees it (PM-1060): no hostname, no address. */
export const ProjectEngineView = z.object({
  id: EngineId,
  name: z.string(),
  online: z.boolean(),
  isDefault: z.boolean(),
  /** The engine's hello lists the project: the machine has a folder for it (its own consent stays the second line). */
  holdsProject: z.boolean(),
  ownedByMe: z.boolean(),
});
export type ProjectEngineView = z.infer<typeof ProjectEngineView>;
export const ProjectEnginesResponse = z.object({ engines: z.array(ProjectEngineView) });
export type ProjectEnginesResponse = z.infer<typeof ProjectEnginesResponse>;
/** `default: true` makes the engine the project's base engine; absent or `false` changes nothing about it. */
export const BindProjectEngineRequest = z.object({ default: z.boolean().optional() }).strict();
export type BindProjectEngineRequest = z.infer<typeof BindProjectEngineRequest>;

/** A project's binding to an engine (PM-1060); `revoked` is `engines.revoked_at != null`. */
export const ProjectEngineBinding = z.object({
  engineId: EngineId,
  isDefault: z.boolean(),
  revoked: z.boolean(),
});
export type ProjectEngineBinding = z.infer<typeof ProjectEngineBinding>;

/**
 * Where the project's new session goes; null: nothing to choose (the start waits with `engine_offline`).
 * 1. A default binding whose engine is not revoked: that engine.
 * 2. A default binding whose engine is revoked: null. It does not move to another machine silently; the
 *    project owner picks a new default.
 * 3. No binding: the global default, while its owner is one of the project's owners; otherwise null.
 */
export function projectEngineOf(input: {
  bindings: readonly ProjectEngineBinding[];
  /** The global default engine that is not revoked; in the local mode `local`, owned by the host owner. */
  globalDefault: { id: EngineId; ownerUserId: string } | null;
  /** The user ids of the members with `owner` access to the project. */
  projectOwnerUserIds: readonly string[];
}): EngineId | null {
  const base = input.bindings.find((binding) => binding.isDefault);
  if (base) return base.revoked ? null : base.engineId;
  if (input.bindings.length > 0) return null;
  const fallback = input.globalDefault;
  return fallback && input.projectOwnerUserIds.includes(fallback.ownerUserId) ? fallback.id : null;
}

interface EngineBindingActor {
  actorUserId: string;
  /** The engine record's `created_by` (a user id, not the display name of `EngineView.createdBy`). */
  engineOwnerUserId: string;
  actorIsProjectOwner: boolean;
}

interface EngineViewer {
  viewerUserId: string;
  viewerIsHostOwner: boolean;
  /** The engine record's `created_by` (a user id). */
  engineOwnerUserId: string;
}

/**
 * Who sees an engine in the status list and in its change events (PM-1061): the host owner sees every one,
 * an engine's owner their own, and a member the engines of their projects (`usedByViewerProject`).
 */
export function canSeeEngine(a: EngineViewer & { usedByViewerProject: boolean }): boolean {
  return a.viewerIsHostOwner || a.engineOwnerUserId === a.viewerUserId || a.usedByViewerProject;
}

/** The machine's name and address are for the engine's owner and the host owner only. */
export function canSeeEngineMachine(a: EngineViewer): boolean {
  return a.viewerIsHostOwner || a.engineOwnerUserId === a.viewerUserId;
}

/** Binding an engine to a project takes both: the machine's owner lets it, the project's owner wants it. */
export function canBindEngine(a: EngineBindingActor): boolean {
  return a.actorUserId === a.engineOwnerUserId && a.actorIsProjectOwner;
}

/** Either side may end it: the machine's owner takes it back, the project's owner lets it go. */
export function canUnbindEngine(a: EngineBindingActor): boolean {
  return a.actorUserId === a.engineOwnerUserId || a.actorIsProjectOwner;
}
