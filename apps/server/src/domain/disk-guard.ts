import { ALERT_SEEN_OPTION, alertPayloadOf } from '@projectman/shared';
import type { DiskLowAlert, EngineId, ProjectConfig } from '@projectman/shared';
import type { EngineDirectory } from '../contracts';
import { ownerHandles } from './access';
import type { DomainContext } from './context';
import { conflict } from './errors';
import type { InboxService } from './inbox';
import type { ProjectService } from './projects';

const GB = 1024 ** 3;

/**
 * Free disk space (PM-243). A full disk froze the owner's machine, so below the project's
 * `minFreeDiskGb` the owners get one `alert` (kept open while the space is short, and withdrawn once
 * there is room again) and admission refuses new AI sessions (`disk_low`); running sessions are not
 * touched and finish their step. A measurement that fails or is not available (`freeBytes` returns
 * null) never blocks anything.
 */
export class DiskGuard {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly inbox: InboxService;
  private readonly freeBytes: () => Promise<number | null>;
  private readonly engines: EngineDirectory | undefined;
  /** Projects whose owners were warned of the shortage that lasts. */
  private readonly told = new Set<string>();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    inbox: InboxService;
    /** The measurement of the server's own disk, when there are no engines. */
    freeBytes?: () => Promise<number | null>;
    /** The engines (PM-311): each is asked for the disk its sessions work on. */
    engines?: EngineDirectory;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.inbox = deps.inbox;
    this.freeBytes = deps.freeBytes ?? (async () => null);
    this.engines = deps.engines;
  }

  /**
   * Free bytes now, or null when they cannot be measured: the target engine's disk, else the least of
   * the connected engines' (the alert is per project, not per engine).
   */
  async free(engineId?: EngineId): Promise<number | null> {
    const engines = this.engines;
    try {
      if (!engines) return await this.freeBytes();
      if (engineId) return (await engines.get(engineId)?.freeDiskBytes()) ?? null;
      let least: number | null = null;
      for (const id of engines.ids()) {
        const free = await engines.get(id)?.freeDiskBytes();
        if (free !== undefined && free !== null && (least === null || free < least)) least = free;
      }
      return least;
    } catch (err) {
      this.ctx.logger.warn({ err }, 'could not measure the free disk space');
      return null;
    }
  }

  /** Throws `disk_low` when the project's limit is not met; raises or withdraws the alert as it finds. */
  async assertRoom(config: ProjectConfig, engineId?: EngineId): Promise<void> {
    const state = await this.evaluate(config, await this.free(engineId));
    if (state.low)
      throw conflict(
        'disk_low',
        `only ${Math.floor(state.freeBytes / GB)} GB of disk space is free (limit ${state.thresholdBytes / GB} GB)`,
        { freeBytes: state.freeBytes, thresholdBytes: state.thresholdBytes },
      );
  }

  /** Every project: one measurement, then the alert raised or withdrawn per project. */
  async check(): Promise<void> {
    const free = await this.free();
    for (const summary of this.projects.summaries()) {
      const config = this.projects.cachedConfig(summary.key);
      if (config) await this.evaluate(config, free);
    }
  }

  private async evaluate(
    config: ProjectConfig,
    free: number | null,
  ): Promise<{ low: boolean; freeBytes: number; thresholdBytes: number }> {
    const thresholdBytes = config.team.limits.minFreeDiskGb * GB;
    const freeBytes = free ?? 0;
    const low = free !== null && thresholdBytes > 0 && free < thresholdBytes;
    const open = this.inbox
      .list(config.project.key, { state: 'open', kind: 'alert' })
      .filter((item) => alertPayloadOf(item)?.alert === 'disk_low');
    if (!low) {
      // Room again (or the check is off): the warning is no longer true, and the next shortage says so anew.
      if (free !== null) {
        this.told.delete(config.project.key);
        for (const item of open) this.inbox.cancel(item.id);
      }
      return { low: false, freeBytes, thresholdBytes };
    }
    const owners = ownerHandles(config);
    // One warning per shortage: an owner who has seen it is not told again every minute.
    if (!this.told.has(config.project.key) && open.length === 0 && owners.length > 0) {
      this.told.add(config.project.key);
      const payload: DiskLowAlert = { alert: 'disk_low', freeBytes, thresholdBytes };
      this.inbox.create({
        projectKey: config.project.key,
        kind: 'alert',
        assignees: owners,
        source: 'system',
        title: `Only ${Math.floor(freeBytes / GB)} GB of disk space is free (limit ${thresholdBytes / GB} GB)`,
        payload,
        options: [ALERT_SEEN_OPTION],
      });
      this.ctx.logger.warn({ freeBytes, thresholdBytes }, 'free disk space is below the limit');
    }
    return { low: true, freeBytes, thresholdBytes };
  }
}
