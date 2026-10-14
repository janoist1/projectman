import type {
  AiMemberConfig,
  ProjectConfig,
  Session,
  SessionStartCause,
  WorkItemRef,
} from '@projectman/shared';

/** What the schedules need from admission (the real `Admission` satisfies it structurally). */
export interface ScheduleAdmission {
  /** Runs `fn` alone among admission decisions and the starts they allow (`Admission.exclusive`). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** The member's session for the schedule run (`Admission.start`). */
  start(request: {
    config: ProjectConfig;
    member: AiMemberConfig;
    workItem: WorkItemRef;
    cause: SessionStartCause;
  }): Promise<{ session: Session }>;
}

/** The minute timer; tests pass a fake. Unchanged shape (moved from domain/schedules.ts). */
export interface ScheduleTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}
