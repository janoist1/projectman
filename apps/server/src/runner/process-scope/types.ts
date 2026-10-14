import type { ProcessScopeKind, ScopeCloseReason, SessionCleanup } from '../../contracts';

export interface ScopeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface OpenScope {
  readonly scopeId: string;
  readonly openedAt: number;
  launch(cmd: { file: string; args: string[]; env: Record<string, string> }): typeof cmd;
  attached(pid: number): void;
  close(reason: ScopeCloseReason, opts: { force: boolean }): Promise<SessionCleanup>;
}
export interface ProcessScopeDriver {
  readonly kind: ProcessScopeKind;
  open(sessionId: string): Promise<OpenScope>;
  recover(): Promise<Array<{ sessionId: string; cleanup: SessionCleanup }>>;
  closeScopes(
    scopes: Array<{ sessionId: string; scopeId: string }>,
  ): Promise<Array<{ sessionId: string; cleanup: SessionCleanup }>>;
}
