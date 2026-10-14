import type { AgentProvider, Session, SessionStop } from '@projectman/shared';
import type { ToolContext } from '../../contracts';
import { newToken } from '../../kernel';

/**
 * What the server holds about each session's current process, in memory: it is gone with the
 * process (`ended`, or `startFailed` when the start itself failed). The sessions' MCP tokens and the
 * promises for their first input are behind methods; the rest are plain per-process records that the
 * orchestrator reads and sets where it starts, restarts and stops a process.
 */
export class LiveSessions {
  /** The provider each session's current process runs, for the transcript it reports. */
  readonly providers = new Map<string, AgentProvider>();
  /** Sessions whose current process resumes a conversation: one that exits before it is ready gives it up (PM-340). */
  readonly resuming = new Set<string>();
  /**
   * Sessions started with an opening input whose first turn has not begun: their CLI reports `idle`
   * once it can take input, before the input is typed (PM-242).
   */
  readonly awaitingFirstTurn = new Set<string>();
  /** The permission mode each session's current process runs in (PM-170): another one restarts it. */
  readonly modes = new Map<string, string | undefined>();
  /** The dedicated merge-fix placement granted to each current process. */
  readonly mergeFixes = new Map<string, { branch: string; cwd: string }>();
  /** The session's grants "for this session" when its current process started. */
  readonly grants = new Map<string, number>();
  /**
   * The reason of a stop in progress, for the end of the session to record when the runner's own exit
   * event reaches it first.
   */
  readonly stopReasons = new Map<string, SessionStop>();

  private readonly tokens = new Map<string, ToolContext>();
  private readonly tokenBySession = new Map<string, string>();
  /** Sessions whose first input (with messages in it) is not known to have reached them: settles it. */
  private readonly firstInputWaiters = new Map<string, (typed: boolean) => void>();

  /** A new MCP token for the session; the one it had is revoked first. */
  issueToken(session: Session): string {
    this.revokeToken(session.id);
    const token = newToken();
    this.tokens.set(token, {
      sessionId: session.id,
      projectKey: session.projectKey,
      member: session.member,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
    });
    this.tokenBySession.set(session.id, token);
    return token;
  }

  revokeToken(sessionId: string): void {
    const token = this.tokenBySession.get(sessionId);
    if (token) this.tokens.delete(token);
    this.tokenBySession.delete(sessionId);
  }

  /** MCP: the session behind /mcp/:token; null rejects the call. */
  resolveToken(token: string): ToolContext | null {
    return this.tokens.get(token) ?? null;
  }

  /** A promise for the session's first input: see `EnsureSessionResult.firstInput`. */
  awaitFirstInput(sessionId: string): Promise<boolean> {
    this.settleFirstInput(sessionId, false);
    return new Promise<boolean>((resolve) => this.firstInputWaiters.set(sessionId, resolve));
  }

  settleFirstInput(sessionId: string, typed: boolean): void {
    const settle = this.firstInputWaiters.get(sessionId);
    this.firstInputWaiters.delete(sessionId);
    settle?.(typed);
  }

  /**
   * The process did not start: what its start set goes. The recorded stop reason stays, as a stop in
   * progress may still want it.
   */
  startFailed(sessionId: string): void {
    this.settleFirstInput(sessionId, false);
    this.awaitingFirstTurn.delete(sessionId);
    this.revokeToken(sessionId);
    this.providers.delete(sessionId);
    this.resuming.delete(sessionId);
    this.modes.delete(sessionId);
    this.mergeFixes.delete(sessionId);
    this.grants.delete(sessionId);
  }

  /**
   * The session ended: everything held for it goes, a waiting first input settles as not typed. Says
   * what the caller needs before it was gone: the recorded stop reason, and whether the process
   * resumed a conversation.
   */
  ended(sessionId: string): { stop: SessionStop | undefined; resuming: boolean } {
    const stop = this.stopReasons.get(sessionId);
    const resuming = this.resuming.has(sessionId);
    this.startFailed(sessionId);
    this.stopReasons.delete(sessionId);
    return { stop, resuming };
  }
}
