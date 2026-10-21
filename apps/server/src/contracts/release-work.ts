/** The kinds of long work a hybrid release waits for before it switches the program (PM-752). */
export type ReleaseWorkKind = 'merge' | 'document_write' | 'full_test' | 'screenshot';

/** One reservation of the release gate: held for as long as the work runs, released once. Never sent over a wire. */
export interface ReleaseWorkPermit {
  readonly id: string;
  readonly kind: ReleaseWorkKind;
  /** Frees the reservation; the root of a work is final only when every child was released. Idempotent. */
  release(): void;
}

export interface ReleaseWorkCounts {
  merges: number;
  documentWrites: number;
  fullTests: number;
  screenshots: number;
}

/**
 * The gate the queues ask before they start long work, and the count the release's drain check reads. The
 * release service implements it; the queues receive it from the assembly and never import the service.
 *
 * A root permit is granted only while the gate is open (no deployment holds the instance's maintenance bit).
 * A child of a permit that is held and not released is granted in maintenance too: it is part of the same
 * work (the test a running merge runs). `runId` is the durable id of the run the work belongs to.
 */
export interface ReleaseWorkAdmission {
  tryAcquire(kind: ReleaseWorkKind, runId: string, parent?: ReleaseWorkPermit): ReleaseWorkPermit | null;
  /** The maintenance bit is up: no new root starts. */
  isHeld(): boolean;
  counts(): ReleaseWorkCounts;
}

/** The gate of an instance that does not release in the hybrid way: never held, hands out permits that count nothing. */
export const OPEN_RELEASE_WORK_ADMISSION: ReleaseWorkAdmission = {
  tryAcquire: (kind, runId) => ({ id: runId, kind, release: () => undefined }),
  isHeld: () => false,
  counts: () => ({ merges: 0, documentWrites: 0, fullTests: 0, screenshots: 0 }),
};
