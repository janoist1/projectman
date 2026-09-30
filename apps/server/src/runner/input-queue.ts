import type { FastifyBaseLogger } from 'fastify';
import type { SessionTiming } from './providers/types';
import { ENTER_KEY, messageKeystrokes } from './typing';

/**
 * Messages typed into an agent CLI's prompt. A message waits in the queue until the session
 * is idle and settled; then it is typed (typing.ts) and Enter is pressed. Until the CLI
 * reports the prompt (UserPromptSubmit) nothing else is typed: Enter is pressed again if the
 * session stays idle (an autocomplete may have eaten it), and after a timeout the queue moves
 * on anyway.
 */

/** What the queue needs from its session. */
export interface InputQueueHost {
  readonly sessionId: string;
  readonly timing: Pick<
    SessionTiming,
    'stepDelayMs' | 'enterDelayMs' | 'enterRetryMs' | 'maxEnterRetries' | 'submitTimeoutMs'
  >;
  readonly logger: FastifyBaseLogger;
  /** The CLI is ready for input and idle. */
  isIdle(): boolean;
  /**
   * The last check before a message is typed: 0 to type it now, a number of milliseconds to
   * check again after, or null to hold the queue until the next pump (e.g. a dialog covers the
   * prompt; the session pumps again once it is gone).
   */
  checkBeforeTyping(): number | null;
  write(data: string): void;
}

interface QueuedMessage {
  text: string;
  resolve(): void;
  reject(err: Error): void;
}

interface AwaitedSubmit {
  at: number;
  retries: number;
  /** A slash command, or a prompt passed on the command line: Enter is never pressed again. */
  command: boolean;
  timeoutMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class InputQueue {
  private readonly host: InputQueueHost;
  private readonly queue: QueuedMessage[] = [];
  private typing = false;
  /** Nothing is typed before this time (the TUI settles after SessionStart, Stop, ...). */
  private notBefore = 0;
  private awaitingSubmit: AwaitedSubmit | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(host: InputQueueHost) {
    this.host = host;
  }

  /** Messages waiting to be typed. */
  get length(): number {
    return this.queue.length;
  }

  /** A typed message (or a command-line prompt) was not reported as submitted yet. */
  get isAwaitingSubmit(): boolean {
    return this.awaitingSubmit !== null;
  }

  /** Queues a message; it is typed once the session is idle. Resolves once typed. */
  enqueue(text: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`Session ${this.host.sessionId} is not running`));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      this.pump();
    });
  }

  /** Types the next message if the session can take it now. */
  pump(): void {
    if (this.closed || this.typing || this.queue.length === 0) return;
    if (this.awaitingSubmit || !this.host.isIdle()) return;
    const now = Date.now();
    if (now < this.notBefore) return this.schedule(this.notBefore - now);
    const wait = this.host.checkBeforeTyping();
    if (wait === null) return;
    if (wait > 0) return this.schedule(wait);
    void this.type(this.queue.shift()!);
  }

  /** Types nothing for `delayMs` (at least), then pumps. */
  schedule(delayMs: number): void {
    if (this.closed) return;
    this.notBefore = Math.max(this.notBefore, Date.now() + delayMs);
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.timers.delete(this.pumpTimer);
    }
    this.pumpTimer = this.timer(() => {
      this.pumpTimer = null;
      this.pump();
    }, delayMs);
  }

  /**
   * The CLI took the prompt (UserPromptSubmit), or started a new conversation (/clear): stop
   * waiting for the typed message to be submitted.
   */
  submitted(): void {
    this.awaitingSubmit = null;
  }

  /**
   * The CLI submits a prompt given on its command line by itself: nothing is typed until it
   * reports it, or `timeoutMs` passed.
   */
  awaitCommandLinePrompt(timeoutMs: number): void {
    this.awaitSubmit(true, timeoutMs);
  }

  /** The process is gone: stops typing and rejects every queued message. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.pumpTimer = null;
    for (const message of this.queue.splice(0)) message.reject(this.exitedError());
  }

  private async type(message: QueuedMessage): Promise<void> {
    const { timing } = this.host;
    this.typing = true;
    try {
      const steps = messageKeystrokes(message.text);
      if (steps.length === 0) {
        message.resolve();
        return;
      }
      for (const step of steps) {
        if (this.closed) throw this.exitedError();
        this.host.write(step);
        await sleep(timing.stepDelayMs);
      }
      await sleep(timing.enterDelayMs);
      if (this.closed) throw this.exitedError();
      this.host.write(ENTER_KEY);
      // A slash command reports no UserPromptSubmit and may open a dialog: never press Enter blindly.
      this.awaitSubmit(message.text.trim().startsWith('/'), timing.submitTimeoutMs);
      message.resolve();
    } catch (err) {
      message.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.typing = false;
    }
  }

  private awaitSubmit(command: boolean, timeoutMs: number): void {
    this.awaitingSubmit = { at: Date.now(), retries: 0, command, timeoutMs };
    this.timer(() => this.checkSubmitted(), this.host.timing.enterRetryMs);
  }

  /** The CLI did not report the prompt yet: press Enter again, or stop waiting for it. */
  private checkSubmitted(): void {
    const pending = this.awaitingSubmit;
    const { timing } = this.host;
    if (!pending || this.closed) return;
    if (Date.now() - pending.at >= pending.timeoutMs) {
      this.host.logger.warn(
        { sessionId: this.host.sessionId },
        'typed message was not reported as submitted',
      );
      this.awaitingSubmit = null;
      this.pump();
      return;
    }
    if (!pending.command && pending.retries < timing.maxEnterRetries && this.host.isIdle()) {
      pending.retries += 1;
      this.host.write(ENTER_KEY);
    }
    this.timer(() => this.checkSubmitted(), timing.enterRetryMs);
  }

  private exitedError(): Error {
    return new Error(`Session ${this.host.sessionId} exited before the message was typed`);
  }

  private timer(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }
}
