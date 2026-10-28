import type { ServerEvent } from '@projectman/shared';
import type { ProcessScopeKind } from './runner';

export interface SessionCleanupFailed {
  projectKey: string;
  sessionId: string;
  scopeId: string;
  kind: ProcessScopeKind;
  survivors: number;
}
export interface SessionCleanupRecovered {
  projectKey: string;
  sessionId: string;
  scopeId: string;
}
/** The owner's override closed the scope's record without proof that its processes stopped (PM-935). */
export type SessionCleanupReleased = SessionCleanupRecovered;

/** In-process pub/sub that feeds the websocket broadcaster. */
export interface EventBus {
  publish(event: ServerEvent): void;
  subscribe(listener: (event: ServerEvent) => void): () => void;
}
