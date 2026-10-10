import {
  formatInjectedTeamMessage,
  formatTeamMessageBatch,
  isOperator,
  memberOf,
  stageOf,
} from '@projectman/shared';
import type { Session, TeamMessage, WorkItemRef } from '@projectman/shared';
import { encodeWorkItem } from '../../db';
import type { DomainContext } from '../context';
import { MAX_FIRST_INPUT_CHARS, MESSAGE_SEPARATOR } from '../sessions';
import type { ProjectService } from '../projects';
import { senderResultLabelFor, staleReasonFor } from './staleness';
import type { EnsureSessionResult, SessionOrchestrator } from '../sessions';
import type { MessageService } from './messages';

/**
 * Types waiting AI messages into running sessions as one batch at idle.
 * A stored message is typed once per recipient and then counts as delivered to it; when typing
 * fails it stays waiting for the recipient's next session. A session that starts for waiting
 * messages takes them in its first input instead (`startAndDeliver`); they count as delivered once
 * that input was typed.
 */
export class MessageDelivery {
  private readonly ctx: DomainContext;
  private readonly sessions: SessionOrchestrator;
  private readonly projects: ProjectService;
  private readonly flushing = new Set<string>();
  private readonly messages: MessageService;
  private messageHolds?: (session: Session) => Promise<boolean>;
  /** Messages being typed, by message and recipient. */
  private readonly claims = new Set<string>();
  /** Recipients whose session is starting for their waiting messages: nothing is typed before it runs. */
  private readonly starting = new Set<string>();
  /**
   * Messages a person wrote into a session that waited for its restart (PM-170), by message and
   * recipient: typed as they were written once it runs, like the ones that reach it at once.
   */
  private readonly asWritten = new Set<string>();
  /**
   * Messages kept back because their recipient's running session is paused (PM-219), by message and
   * recipient, with the session they are for. Memory only: a restart leaves the session without a
   * process, and the messages wait like any that wait for a start (the resume starts it with them).
   */
  private readonly pauseHeld = new Map<string, { sessionId: string; messageId: string; member: string }>();
  /**
   * Notices kept for idle sessions (PM-249), by session id: typed before the session's next input. A
   * stored message kept the same way (PM-421, `holdUntilInput`) counts as delivered once typed.
   */
  private readonly held = new Map<string, HeldNotice[]>();

  constructor(deps: {
    ctx: DomainContext;
    sessions: SessionOrchestrator;
    projects: ProjectService;
    messages: MessageService;
  }) {
    this.ctx = deps.ctx;
    this.sessions = deps.sessions;
    this.projects = deps.projects;
    this.messages = deps.messages;
  }

  /**
   * Types a stored message into its recipient's session, once. `text` is what is typed: by
   * default the message with its team prefix, `[team message from <handle> about <KEY>]`.
   */
  deliver(session: Session, message: TeamMessage, text?: string): void {
    const claim = `${message.id}:${session.member}`;
    if (this.claims.has(claim)) return;
    this.claims.add(claim);
    const plain = this.asWritten.has(claim);
    Promise.resolve()
      .then(async () => {
        const { text: typed, messageIds } = this.withHeld(
          session,
          text ??
            (plain && !message.via
              ? message.body
              : formatInjectedTeamMessage(message.from, message.body, message.taskKey, message.via)),
        );
        await this.sessions.typeInto(session, typed);
        for (const id of messageIds) this.messages.markRecipientDelivered(id, session.member);
      })
      .then(() => {
        this.asWritten.delete(claim);
        return this.messages.markRecipientDelivered(message.id, session.member);
      })
      .catch((err: unknown) =>
        this.ctx.logger.warn({ err, messageId: message.id }, 'team message delivery failed'),
      )
      .finally(() => this.claims.delete(claim));
  }

  /** Binds the card's existing refinement and fix-limit holds after messaging is built. */
  useMessageHolds(check: (session: Session) => Promise<boolean>): void {
    this.messageHolds = check;
  }

  /**
   * Starts the session of an AI recipient of waiting messages, then types them in. The session
   * takes the waiting messages in its first input instead, in order and in full, so that it does not
   * work from the excerpts until its first turn ends (PM-180): `start` gets their text, as it is
   * typed in, and hands it to the session start (`SessionOrchestrator.ensureSession`). Nothing is
   * typed into the session while it starts, so the messages keep their order; the ones the session
   * took count as delivered, the rest (what did not fit its first input) is typed once it runs. A
   * failing start throws and leaves the messages waiting.
   */
  async startAndDeliver(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    start: (messages: string[]) => Promise<EnsureSessionResult>,
  ): Promise<void> {
    const recipient = recipientKey(projectKey, handle, workItem);
    const waiting = this.messages.waiting(projectKey, handle, workItem);
    let result: EnsureSessionResult;
    this.starting.add(recipient);
    try {
      const batch = await this.batch(projectKey, handle, workItem, waiting);
      result = await start(batch.messages.length ? [batch.text] : []);
      this.deliverWithFirstInput(handle, result.messagesSent ? batch.messages : [], result.firstInput);
    } finally {
      this.starting.delete(recipient);
    }
    this.deliverWaiting(result.session);
  }

  /**
   * Messages a session took in its first input count as delivered to `handle` once that input was
   * typed (`EnsureSessionResult.firstInput`), not when the process started: one that ends first
   * (a lost login, a start-up dialog, a crash) never got them, so they stay waiting for the next
   * session (PM-189). Until then nothing types them again.
   */
  deliverWithFirstInput(handle: string, messages: TeamMessage[], firstInput: Promise<boolean>): void {
    const claims = messages.map((message) => `${message.id}:${handle}`);
    for (const claim of claims) this.claims.add(claim);
    firstInput
      .then((typed) => {
        if (typed) for (const message of messages) this.messages.markRecipientDelivered(message.id, handle);
      })
      .catch((err: unknown) => this.ctx.logger.warn({ err }, 'team message delivery failed'))
      .finally(() => {
        for (const claim of claims) this.claims.delete(claim);
      });
  }

  /**
   * A person wrote into a session that waits for its restart (PM-170): the message waits with the
   * others and is typed as it was written, without the team prefix, once the session runs again.
   */
  holdAsWritten(session: Session, message: TeamMessage): void {
    this.asWritten.add(`${message.id}:${session.member}`);
  }

  /**
   * The session is paused (PM-219): the message waits, stored, and goes in when the pause is over
   * (`deliverPauseHeld`). Not `deliverWaiting`'s business: that one would also type what other holds
   * keep back (the fix round limit, a refinement turn).
   */
  holdForPause(session: Session, message: TeamMessage): void {
    this.pauseHeld.set(`${message.id}:${session.member}`, {
      sessionId: session.id,
      messageId: message.id,
      member: session.member,
    });
  }

  /** The messages kept back for the session's pause go in now, in the order they came. */
  deliverPauseHeld(session: Session): void {
    for (const [claim, held] of [...this.pauseHeld]) {
      if (held.sessionId !== session.id) continue;
      this.pauseHeld.delete(claim);
      const message = this.messages.get(held.messageId);
      const receipt = message?.receipts?.find((r) => r.handle === held.member);
      // Taken in by another way meanwhile (a restart's first input): not typed twice.
      const config = this.projects.cachedConfig(session.projectKey);
      if (message && !receipt?.deliveredAt && config && memberOf(config, message.from)?.kind === 'human')
        this.deliver(session, message);
    }
    this.deliverWaiting(session);
  }

  /** The session's held messages are not typed in any more: its restart takes them as waiting ones. */
  dropPauseHeld(sessionId: string): void {
    for (const [claim, held] of [...this.pauseHeld])
      if (held.sessionId === sessionId) this.pauseHeld.delete(claim);
  }

  /** Types the messages waiting for the session's member and work item (after it started). */
  deliverWaiting(session: Session): void {
    const current = this.sessions.find(session.id);
    const config = this.projects.cachedConfig(session.projectKey);
    // Human inputs retain the existing queue and as-written restart behavior (K3/K6).
    if (
      current &&
      config &&
      this.sessions.isRunning(current.id) &&
      !this.sessions.isPaused(current) &&
      !this.sessions.permissionRestartDue(current) &&
      !this.starting.has(recipientKey(current.projectKey, current.member, current.workItem))
    ) {
      // The Operator's messages only go in as a batch with an owner's (PM-463), never one by one.
      if (!isOperator(memberOf(config, current.member)))
        for (const message of this.messages.waiting(current.projectKey, current.member, current.workItem))
          if (memberOf(config, message.from)?.kind === 'human') this.deliver(current, message);
    }
    void this.flushWaiting(session).catch((err: unknown) =>
      this.ctx.logger.warn({ err, sessionId: session.id }, 'team message batch delivery failed'),
    );
  }

  /** Claims one snapshot of waiting messages and types it as a single input at idle. */
  async flushWaiting(session: Session): Promise<boolean> {
    if (await this.messageHolds?.(session)) return false;
    const current = this.sessions.find(session.id);
    if (
      !current ||
      current.state !== 'idle' ||
      !this.sessions.isRunning(current.id) ||
      this.sessions.isPaused(current) ||
      this.sessions.hasPendingInput(current.id) ||
      this.sessions.permissionRestartDue(current) ||
      this.starting.has(recipientKey(current.projectKey, current.member, current.workItem)) ||
      this.flushing.has(current.id)
    )
      return false;
    // A stored message kept for the session's next input goes in with it, not on its own (PM-421).
    const keptIds = new Set(
      (this.held.get(current.id) ?? []).flatMap((notice) => (notice.messageId ? [notice.messageId] : [])),
    );
    const waiting = this.messages
      .waiting(current.projectKey, current.member, current.workItem)
      .filter((message) => !this.claims.has(`${message.id}:${current.member}`) && !keptIds.has(message.id));
    const config = this.projects.cachedConfig(current.projectKey);
    if (
      this.sessions.reviewRoundDue(current) &&
      config &&
      waiting.some((m) => this.messages.wakes(config, m, current.member))
    )
      return false;
    if (!waiting.length) return false;
    // An idle Operator is typed into only for the owner's message; an AI member's waits to ride along (PM-463).
    const operator = !!config && isOperator(memberOf(config, current.member));
    const wakesOperator = (m: TeamMessage) => !!config && this.messages.wakes(config, m, current.member);
    if (operator && !waiting.some(wakesOperator)) return false;
    this.flushing.add(current.id);
    for (const message of waiting) this.claims.add(`${message.id}:${current.member}`);
    try {
      const batch = await this.batch(current.projectKey, current.member, current.workItem, waiting);
      const fresh = this.sessions.find(current.id);
      if (
        !fresh ||
        fresh.state !== 'idle' ||
        this.sessions.hasPendingInput(current.id) ||
        this.sessions.isPaused(fresh) ||
        this.sessions.permissionRestartDue(fresh) ||
        (this.sessions.reviewRoundDue(fresh) &&
          config &&
          batch.messages.some((m) => this.messages.wakes(config, m, current.member)))
      )
        return false;
      if (!batch.messages.length || (operator && !batch.messages.some(wakesOperator))) return false;
      const held = this.held.get(fresh.id) ?? [];
      let text = batch.text;
      let taken = 0;
      for (const notice of held) {
        if (text.length + MESSAGE_SEPARATOR.length + notice.text.length > MAX_FIRST_INPUT_CHARS) break;
        text += MESSAGE_SEPARATOR + notice.text;
        taken++;
      }
      await this.sessions.typeInto(fresh, text);
      // Keep notices on failure, and preserve ones appended while the input was being typed.
      const remaining = (this.held.get(fresh.id) ?? []).slice(taken);
      if (remaining.length) this.held.set(fresh.id, remaining);
      else this.held.delete(fresh.id);
      for (const message of batch.messages) this.messages.markRecipientDelivered(message.id, current.member);
      for (const notice of held.slice(0, taken))
        if (notice.messageId) this.messages.markRecipientDelivered(notice.messageId, current.member);
      return true;
    } finally {
      for (const message of waiting) this.claims.delete(`${message.id}:${current.member}`);
      this.flushing.delete(current.id);
    }
  }

  private async batch(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    waiting: TeamMessage[],
  ): Promise<{ text: string; messages: TeamMessage[] }> {
    const config = await this.projects.config(projectKey);
    const taskKey = workItem.type === 'task' ? workItem.taskKey : null;
    const source = taskKey ? this.ctx.repos.tasks.get(taskKey) : null;
    const head = source ? await this.sessions.sourceHead(config, source) : null;
    const task = taskKey ? this.ctx.repos.tasks.get(taskKey) : null;
    const stage = task ? stageOf(config, task.stageId) : null;
    const card = task
      ? {
          stageId: task.stageId,
          stageName: stage?.name ?? task.stageId,
          commit: head?.commit ?? null,
          labels: task.labels,
        }
      : null;
    const messages: TeamMessage[] = [];
    let text = '';
    const operator = isOperator(memberOf(config, handle));
    for (const message of waiting) {
      const next = [...messages, message];
      const candidate = formatTeamMessageBatch(
        taskKey,
        card,
        next.map((m) => ({
          from: m.from,
          via: m.via,
          // What does not wake the Operator is information for it, not an instruction (PM-463).
          ...(operator && !this.messages.wakes(config, m, handle) ? { info: true } : {}),
          taskKey: m.taskKey,
          body: m.body,
          kind: m.kind ?? 'action',
          sentAt: m.createdAt,
          version: m.version,
          stale: staleReasonFor(this.ctx, config, m, handle) ?? undefined,
          staleDetail: senderResultLabelFor(this.ctx, config, m, handle) ?? stage?.name,
        })),
      );
      if (candidate.length + MESSAGE_SEPARATOR.length > MAX_FIRST_INPUT_CHARS) break;
      messages.push(message);
      text = candidate;
    }
    return { text, messages };
  }

  /** Types a notice with the team prefix that is not stored as a message. */
  notice(session: Session, from: string, text: string, taskKey: string | null): void {
    Promise.resolve()
      .then(async () => {
        const { text: typed, messageIds } = this.withHeld(
          session,
          formatInjectedTeamMessage(from, text, taskKey),
        );
        await this.sessions.typeInto(session, typed);
        for (const id of messageIds) this.messages.markRecipientDelivered(id, session.member);
      })
      .catch((err: unknown) =>
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not deliver a message'),
      );
  }

  /**
   * Keep an idle session's notice for its next input (PM-249); busy sessions retain
   * the existing runner queue delivery of coordination and answer notices.
   */
  noticeOrHold(session: Session, from: string, text: string, taskKey: string | null): void {
    if (session.state !== 'idle') return this.notice(session, from, text, taskKey);
    this.keep(session, { text: formatInjectedTeamMessage(from, text, taskKey), messageId: null });
  }

  /**
   * An idle session gets the stored message before its next input, and starts nothing for it (PM-421).
   * `flushWaiting` leaves it alone, so an idle session is not typed into only for it; it counts as
   * delivered once typed. When the session ends first, it stays waiting for the member's next session.
   */
  holdUntilInput(session: Session, message: TeamMessage): void {
    this.keep(session, {
      text: formatInjectedTeamMessage(message.from, message.body, message.taskKey),
      messageId: message.id,
    });
  }

  private keep(session: Session, notice: HeldNotice): void {
    const kept = this.held.get(session.id) ?? [];
    kept.push(notice);
    this.held.set(session.id, kept);
  }

  /** Drops what was kept for a session that ended (`session_ended`). */
  dropHeld(sessionId: string): void {
    this.held.delete(sessionId);
  }

  /** `text` with the notices kept for the session in front of it, and the stored messages among them; they are taken out. */
  private withHeld(session: Session, text: string): { text: string; messageIds: string[] } {
    const kept = this.held.get(session.id);
    if (!kept) return { text, messageIds: [] };
    this.held.delete(session.id);
    return {
      text: [...kept.map((notice) => notice.text), text].join(MESSAGE_SEPARATOR),
      messageIds: kept.flatMap((notice) => (notice.messageId ? [notice.messageId] : [])),
    };
  }
}

/** A notice kept for an idle session; `messageId` is set when a stored message is behind it. */
interface HeldNotice {
  text: string;
  messageId: string | null;
}

function recipientKey(projectKey: string, handle: string, workItem: WorkItemRef): string {
  const wi = encodeWorkItem(workItem);
  return `${projectKey}:${handle}:${wi.type}:${wi.ref}`;
}
