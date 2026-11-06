import type { EngineId, MachineBusyAlert, ProjectConfig } from '@projectman/shared';
import type { EngineDirectory, MachineLoad } from '../../contracts';
import type { DomainContext } from '../../core/base';
import { conflict } from '../../kernel';
import type { InboxService } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';

/** How long a measurement of an engine's load serves the admission checks (the `machine` watcher measures afresh). */
const LOAD_CACHE_MS = 10_000;

/** A measurement this old still answers `assertRoom` at once while the next one is taken in the background. */
const LOAD_STALE_MS = 5 * LOAD_CACHE_MS;

/** Critical pressure that lasts this long becomes a todo of the integrator. */
const CRITICAL_ALERT_AFTER_MS = 10 * 60_000;

/** Critical readings further apart than this are not one spell: the pressure may have eased in between. */
const CRITICAL_GAP_MS = 5 * 60_000;

/**
 * The memory pressure of the machine an engine runs on (PM-1278 B2). While an engine measures `critical`,
 * admission refuses new AI sessions on it (`machine_busy`); running sessions are not touched. `warn` is
 * frequent on macOS under an ordinary load and holds nothing back, and a load that cannot be measured
 * (`machineLoad` returns null, or the reading is stale) never blocks anything. When the critical pressure
 * lasts more than ten minutes the integrator gets one todo, withdrawn once it has eased.
 */
export class MachineGuard {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly inbox: InboxService;
  private readonly engines: Pick<EngineDirectory, 'get' | 'projectEngine'> | undefined;
  /** Projects whose integrator was told of the spell that lasts. */
  private readonly told = new Set<string>();
  /** The engines whose last reading was critical: since when, and the last reading of the spell. */
  private readonly critical = new Map<EngineId, { since: number; last: number }>();
  /** The last successful measurement per engine. */
  private readonly measured = new Map<EngineId, { at: number; load: MachineLoad }>();
  /** The measurements under way per engine: concurrent starts share one. */
  private readonly measuring = new Map<EngineId, Promise<MachineLoad | null>>();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    inbox: InboxService;
    /** The engines (PM-311): each is asked for the load of its machine. */
    engines?: Pick<EngineDirectory, 'get' | 'projectEngine'>;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.inbox = deps.inbox;
    this.engines = deps.engines;
  }

  private now(): number {
    return this.ctx.now().getTime();
  }

  /** The engine's load now, or null when it cannot be measured. */
  private async load(engineId: EngineId): Promise<MachineLoad | null> {
    try {
      return (await this.engines?.get(engineId)?.machineLoad()) ?? null;
    } catch (err) {
      this.ctx.logger.warn({ err, engineId }, 'could not measure the memory pressure of the machine');
      return null;
    }
  }

  /** The measurement `assertRoom` uses: at most `LOAD_CACHE_MS` old, so a round of starts asks the engine once. */
  private async loadCached(engineId: EngineId): Promise<MachineLoad | null> {
    const known = this.measured.get(engineId);
    const age = known ? this.now() - known.at : Infinity;
    if (known && age < LOAD_CACHE_MS) return known.load;
    let measuring = this.measuring.get(engineId);
    if (!measuring) {
      measuring = this.load(engineId)
        .then((load) => {
          // A failed measurement is asked again at the next start, not remembered.
          if (load === null) this.measured.delete(engineId);
          else this.measured.set(engineId, { at: this.now(), load });
          return load;
        })
        .finally(() => this.measuring.delete(engineId));
      this.measuring.set(engineId, measuring);
    }
    // Admission asks under its lock (PM-1133): an older measurement answers while a fresh one is taken behind it.
    return known && age < LOAD_STALE_MS ? known.load : measuring;
  }

  /**
   * Throws `machine_busy` while the target engine's memory pressure is critical; raises or withdraws the
   * alert as it finds. The reading is the cached measurement (`LOAD_CACHE_MS`): admission asks for every start.
   */
  async assertRoom(config: ProjectConfig, engineId?: EngineId): Promise<void> {
    if (!engineId) return;
    const load = await this.loadCached(engineId);
    if (this.evaluate(config, engineId, load?.pressure ?? null))
      throw conflict('machine_busy', 'the memory of the machine is under critical pressure', {
        pressure: 'critical',
      });
  }

  /** Every project: one fresh measurement of its engine, then the alert raised or withdrawn. */
  async check(): Promise<void> {
    // The watcher's reading is newer than any cached one: the admission checks measure afresh after it.
    this.measured.clear();
    for (const summary of this.projects.summaries()) {
      const config = this.projects.cachedConfig(summary.key);
      const engineId = config ? this.engines?.projectEngine(summary.key) : null;
      if (config && engineId) this.evaluate(config, engineId, (await this.load(engineId))?.pressure ?? null);
    }
  }

  /** Whether the engine is under critical pressure now; keeps the spell and the project's todo up to date. */
  private evaluate(config: ProjectConfig, engineId: EngineId, pressure: MachineLoad['pressure']): boolean {
    // Not measurable: nothing is blocked, and what is known of a spell or an alert stays as it was.
    if (pressure === null) return false;
    const now = this.now();
    const projectKey = config.project.key;
    if (pressure !== 'critical') {
      this.critical.delete(engineId);
      // Eased everywhere: the todo is no longer true, and the next spell says so anew.
      if (this.critical.size === 0) {
        this.told.delete(projectKey);
        this.inbox.settleAlert(projectKey, 'machine_busy');
      }
      return false;
    }
    const known = this.critical.get(engineId);
    const spell = known && now - known.last <= CRITICAL_GAP_MS ? known : { since: now, last: now };
    spell.last = now;
    this.critical.set(engineId, spell);
    const lasted = now - spell.since;
    // One todo per spell: the integrator is not asked again every minute (`raiseAlert` keeps one open).
    if (lasted >= CRITICAL_ALERT_AFTER_MS && !this.told.has(projectKey)) {
      this.told.add(projectKey);
      const minutes = Math.floor(lasted / 60_000);
      const payload: MachineBusyAlert = { alert: 'machine_busy', minutes };
      this.inbox.raiseAlert({
        projectKey,
        title: `The memory of the machine has been under critical pressure for ${minutes} minutes`,
        payload,
      });
      this.ctx.logger.warn({ engineId, minutes }, 'the memory pressure of the machine stays critical');
    }
    return true;
  }
}
