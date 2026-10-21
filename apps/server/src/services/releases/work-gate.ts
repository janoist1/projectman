import type {
  ReleaseWorkAdmission,
  ReleaseWorkCounts,
  ReleaseWorkKind,
  ReleaseWorkPermit,
} from '../../contracts';

interface Entry {
  readonly permit: ReleaseWorkPermit;
  readonly parent: Entry | null;
  released: boolean;
  /** Children granted and not released yet: the work is over only when they are too. */
  children: number;
}

/**
 * The work gate of a hybrid release (PM-752). The fence is the deployment's maintenance bit, read from the
 * database at every question, so it holds from the first moment of a restart, before any recovery runs. The
 * permits themselves are in memory: work that a previous process started has none, and the drain check
 * treats such a run (a `running` row without a permit) as uncertain.
 */
export class ReleaseWorkGate implements ReleaseWorkAdmission {
  private readonly entries = new Set<Entry>();
  private sequence = 0;
  private readonly maintenance: () => boolean;

  constructor(maintenance: () => boolean) {
    this.maintenance = maintenance;
  }

  isHeld(): boolean {
    return this.maintenance();
  }

  tryAcquire(kind: ReleaseWorkKind, runId: string, parent?: ReleaseWorkPermit): ReleaseWorkPermit | null {
    const parentEntry = parent ? this.find(parent) : null;
    // Maintenance lets only the continuation of work that is still held through; a root waits.
    if (this.maintenance() && !(parentEntry && !parentEntry.released)) return null;
    const entry: Entry = {
      permit: {
        id: `${kind}:${runId}:${++this.sequence}`,
        kind,
        release: () => this.release(entry),
      },
      parent: parentEntry,
      released: false,
      children: 0,
    };
    if (parentEntry) parentEntry.children++;
    this.entries.add(entry);
    return entry.permit;
  }

  /** The roots that are not final: held themselves, or through a child that is. */
  counts(): ReleaseWorkCounts {
    const counts: ReleaseWorkCounts = { merges: 0, documentWrites: 0, fullTests: 0, screenshots: 0 };
    for (const entry of this.entries) {
      if (entry.parent) continue;
      switch (entry.permit.kind) {
        case 'merge':
          counts.merges++;
          break;
        case 'document_write':
          counts.documentWrites++;
          break;
        case 'full_test':
          counts.fullTests++;
          break;
        case 'screenshot':
          counts.screenshots++;
          break;
      }
    }
    return counts;
  }

  private find(permit: ReleaseWorkPermit): Entry | null {
    for (const entry of this.entries) if (entry.permit === permit) return entry;
    return null;
  }

  private release(entry: Entry): void {
    if (entry.released) return;
    entry.released = true;
    this.settle(entry);
  }

  /** Drops an entry that is released and has no live child, then the parent that waited for it. */
  private settle(entry: Entry): void {
    if (!entry.released || entry.children > 0) return;
    if (!this.entries.delete(entry)) return;
    if (entry.parent) {
      entry.parent.children--;
      this.settle(entry.parent);
    }
  }
}
