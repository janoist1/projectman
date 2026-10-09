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
