import { ERROR_CODES } from '@projectman/shared';
import type { ErrorCode } from '@projectman/shared';
import { DomainError, conflict, notFound, sleep as defaultSleep, unavailable } from '../kernel';
import type {
  AdministrationCapability,
  AdministrationCommand,
  AdministrationExecutors,
  AdministrationJob,
  AdministrationPort,
  AdministrationResult,
  AdministrationStatus,
  AdministrationSubmit,
  AdministrationTarget,
} from '../contracts';
import { MAX_DIAGNOSTIC_ENTRIES } from '../contracts';
import type { DiagnosticFields } from './diagnostics';
import type { MachineReader } from './machine';
import type { ProcessCleaner } from './processes';
import type { OwnerCommandRunner } from './owner-command';
import type { SupervisorConfig } from './schemas';
import { filterEntries } from './service-logs';
import type { ServiceLogReader } from './service-logs';
import type { ServiceController } from './service-control';
import { commandKey } from './store';
import type { DiagnosticsJournal, OperationRecord, OperationStore } from './store';

/**
 * The supervisor core (PM-763): runs on the machine it manages, answers `status`, `logs`, `submit` and
 * `inspect` for exactly that machine's target, and carries out the typed commands. A restart is written to the
 * durable store before the service manager is asked, is never repeated after a crash, and counts as done only
 * when the service reports a new boot id. The business commands (full test, image build, deploy) are only
 * forwarded to the executors the installation provides.
 */

interface SupervisorDeps {
  config: Pick<SupervisorConfig, 'target'>;
  /** Null: this host's service manager does not match the configured service; nothing can be restarted. */
  controller: ServiceController | null;
  store: OperationStore;
  journal: DiagnosticsJournal;
  executors?: AdministrationExecutors;
  /** The machine snapshot reader (PM-886); absent where the host cannot report its state. */
  machine?: MachineReader;
  /** The managed service's own log; absent or unavailable when the installation has none to read. */
  serviceLogs?: ServiceLogReader;
  /** The orphan test worker cleanup; absent or unsupported where the host cannot list and signal processes. */
  cleaner?: ProcessCleaner;
  /** Installed only when this machine explicitly enables the owner's shell (PM-887). */
  ownerCommand?: OwnerCommandRunner;
  version?: string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  restartTimeoutMs?: number;
  pollMs?: number;
}

export interface Supervisor extends AdministrationPort {
  /** Re-checks the operations a previous run left unfinished; call once after start-up. */
  recover(): Promise<void>;
  /** Waits for the running operation (tests and an orderly stop). */
  idle(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_RESTART_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 1_000;

const sameTarget = (a: AdministrationTarget, b: AdministrationTarget) =>
  a.kind === 'hub' ? b.kind === 'hub' : b.kind === 'engine' && a.id === b.id;

const knownCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const restartTimeoutMs = deps.restartTimeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const executors = deps.executors ?? {};
  let queue: Promise<unknown> = Promise.resolve();
  let running: Promise<void> = Promise.resolve();
  let closed = false;
  const abort = new AbortController();

  const log: DiagnosticsJournal['append'] = (code, fields) =>
    deps.journal.append(code, fields).catch(() => undefined);

  /** Serializes the check-and-accept steps so two submits never both see "no operation running". */
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const requireOwnTarget = (target: AdministrationTarget) => {
    if (!sameTarget(target, deps.config.target))
      throw conflict('administration_target_mismatch', 'this supervisor manages another target');
  };

  const capabilities = (): AdministrationCapability[] => {
    const out: AdministrationCapability[] = ['status', 'logs'];
    if (deps.machine) out.push('machine');
    if (deps.serviceLogs?.available()) out.push('service_logs');
    if (deps.controller) out.push('restart');
    if (executors.full_test) out.push('full_test');
    if (executors.image_build) out.push('image_build');
    if (executors.deploy) out.push('deploy');
    if (deps.ownerCommand) out.push('owner_command');
    return out;
  };

  const job = (
    operationId: string,
    state: AdministrationJob['state'],
    patch: { result?: AdministrationResult | null; errorCode?: ErrorCode | null } = {},
  ): AdministrationJob => ({
    operationId,
    state,
    result: patch.result ?? null,
    errorCode: patch.errorCode ?? null,
    updatedAt: now().toISOString(),
  });

  async function finish(
    record: OperationRecord,
    state: 'succeeded' | 'failed' | 'unknown',
    patch: { result?: AdministrationResult | null; errorCode?: ErrorCode | null } = {},
  ): Promise<void> {
    await deps.store.setJob(record.operationId, job(record.operationId, state, patch));
    const fields: DiagnosticFields = { operationId: record.operationId, kind: record.command.kind };
    if (patch.errorCode) fields.errorCode = patch.errorCode;
    await log(
      state === 'succeeded'
        ? 'operation_succeeded'
        : state === 'failed'
          ? 'operation_failed'
          : 'operation_unknown',
      fields,
    );
  }

  async function runRestart(
    record: OperationRecord,
    command: Extract<AdministrationCommand, { kind: 'restart' }>,
  ): Promise<void> {
    const controller = deps.controller;
    if (!controller) return finish(record, 'failed', { errorCode: 'administration_unavailable' });
    // Written first: after this a crash can no longer be told apart from "restart asked" by anything but the boot id.
    await deps.store.setJob(record.operationId, job(record.operationId, 'running'));
    await log('restart_requested', { operationId: record.operationId, bootId: command.expectedBootId });
    try {
      await controller.restart();
    } catch {
      await log('restart_failed', { operationId: record.operationId, errorCode: 'administration_failed' });
      return finish(record, 'failed', { errorCode: 'administration_failed' });
    }
    return confirmRestart(record, command.expectedBootId);
  }

  async function confirmRestart(record: OperationRecord, expectedBootId: string): Promise<void> {
    const controller = deps.controller!;
    const deadline = Date.now() + restartTimeoutMs;
    for (;;) {
      const probe = await controller.probe().catch(() => ({ running: false, bootId: null }));
      if (probe.running && probe.bootId && probe.bootId !== expectedBootId) {
        await log('restart_confirmed', { operationId: record.operationId, bootId: probe.bootId });
        return finish(record, 'succeeded', {
          result: { kind: 'restart', bootId: probe.bootId, version: deps.version ?? null },
        });
      }
      if (closed || Date.now() >= deadline) {
        await log('restart_failed', { operationId: record.operationId, errorCode: 'administration_failed' });
        return finish(record, 'failed', { errorCode: 'administration_failed' });
      }
      await sleep(pollMs);
    }
  }

  async function runCleanup(
    record: OperationRecord,
    command: Extract<AdministrationCommand, { kind: 'process_cleanup' }>,
  ): Promise<void> {
    if (!deps.cleaner) return finish(record, 'failed', { errorCode: 'administration_unavailable' });
    await deps.store.setJob(record.operationId, job(record.operationId, 'running'));
    try {
      const counts = await deps.cleaner.cleanup(command.selector);
      await log('cleanup_finished', { operationId: record.operationId, ...counts });
      await finish(record, 'succeeded', { result: { kind: 'process_cleanup', ...counts } });
    } catch {
      await finish(record, 'failed', { errorCode: 'administration_failed' });
    }
  }

  async function runExecutor(record: OperationRecord, command: AdministrationCommand): Promise<void> {
    await deps.store.setJob(record.operationId, job(record.operationId, 'running'));
    try {
      let result: AdministrationResult;
      if (command.kind === 'full_test' && executors.full_test)
        result = await executors.full_test(command, abort.signal);
      else if (command.kind === 'image_build' && executors.image_build)
        result = await executors.image_build(command, abort.signal);
      else if (command.kind === 'deploy' && executors.deploy)
        result = await executors.deploy(command, abort.signal);
      else if (command.kind === 'owner_command' && deps.ownerCommand)
        result = await deps.ownerCommand(command, abort.signal);
      else return finish(record, 'failed', { errorCode: 'administration_unavailable' });
      await finish(record, 'succeeded', { result });
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : null;
      await finish(record, 'failed', { errorCode: knownCode(code) ? code : 'administration_failed' });
    }
  }

  function start(record: OperationRecord): void {
    const { command } = record;
    const work =
      command.kind === 'restart'
        ? runRestart(record, command)
        : command.kind === 'process_cleanup'
          ? runCleanup(record, command)
          : runExecutor(record, command);
    running = work
      .catch(async () => {
        await finish(record, 'failed', { errorCode: 'administration_failed' }).catch(() => undefined);
      })
      .then(() => undefined);
    void log('operation_started', { operationId: record.operationId, kind: command.kind });
  }

  async function checkAcceptable(command: AdministrationCommand): Promise<void> {
    if (command.kind === 'restart') {
      requireOwnTarget(command.target);
      if (!deps.controller)
        throw unavailable('administration_unavailable', 'no service manager for this supervisor');
      const probe = await deps.controller.probe().catch(() => null);
      if (!probe) throw unavailable('administration_unavailable', 'the service manager cannot be reached');
      if (!probe.running || !probe.bootId)
        throw unavailable('administration_unavailable', 'the service is not running');
      if (probe.bootId !== command.expectedBootId)
        throw conflict('administration_boot_mismatch', 'the service has started since the status was read');
      return;
    }
    if (command.kind === 'process_cleanup') {
      requireOwnTarget(command.target);
      if (!deps.cleaner?.supported())
        throw unavailable('administration_unavailable', 'this host cannot stop processes');
      return;
    }
    if (command.kind === 'owner_command') {
      requireOwnTarget(command.target);
      if (!deps.ownerCommand)
        throw unavailable('administration_unavailable', 'this host has not enabled owner commands');
      return;
    }
    if (!executors[command.kind])
      throw unavailable('administration_unavailable', `this installation cannot run ${command.kind}`);
  }

  return {
    async status(target): Promise<AdministrationStatus> {
      requireOwnTarget(target);
      const probe = deps.controller ? await deps.controller.probe().catch(() => null) : null;
      const unfinished = await deps.store.unfinished();
      return {
        target: deps.config.target,
        online: probe?.running ?? false,
        version: deps.version ?? null,
        bootId: probe?.running ? probe.bootId : null,
        capabilities: capabilities(),
        activeOperationId: unfinished[0]?.operationId ?? null,
      };
    },

    async logs(target, options) {
      requireOwnTarget(target);
      if (options.source === 'service') {
        if (!deps.serviceLogs?.available())
          throw unavailable('administration_unavailable', 'this installation has no service log');
        return { entries: await deps.serviceLogs.read(options) };
      }
      // The filters run on the whole journal, the newest `limit` of what is left are returned.
      return { entries: filterEntries(await deps.journal.read(MAX_DIAGNOSTIC_ENTRIES), options) };
    },

    async machine(target) {
      requireOwnTarget(target);
      if (!deps.machine) throw unavailable('administration_unavailable', 'this host cannot report its state');
      return deps.machine.snapshot();
    },

    submit(input: AdministrationSubmit) {
      return exclusive(async () => {
        if (closed) throw unavailable('administration_unavailable', 'the supervisor is stopping');
        const existing = await deps.store.get(input.operationId);
        if (existing) {
          if (commandKey(existing.command) !== commandKey(input.command)) {
            await log('submit_refused', {
              operationId: input.operationId,
              errorCode: 'administration_operation_conflict',
            });
            throw conflict(
              'administration_operation_conflict',
              'the operation id was used for another command',
            );
          }
          await log('submit_duplicate', { operationId: input.operationId, kind: input.command.kind });
          return { accepted: true };
        }
        const active = await deps.store.unfinished();
        if (active.length > 0) {
          await log('submit_refused', {
            operationId: input.operationId,
            errorCode: 'administration_operation_conflict',
          });
          throw conflict('administration_operation_conflict', 'another operation is still running');
        }
        try {
          await checkAcceptable(input.command);
        } catch (err) {
          const errorCode = err instanceof DomainError ? err.code : 'administration_failed';
          await log('submit_refused', {
            operationId: input.operationId,
            kind: input.command.kind,
            errorCode,
          });
          throw err;
        }
        const record: OperationRecord = {
          operationId: input.operationId,
          requestId: input.requestId,
          command: input.command,
          job: job(input.operationId, 'accepted'),
          createdAt: now().toISOString(),
        };
        await deps.store.create(record);
        await log('submit_accepted', { operationId: input.operationId, kind: input.command.kind });
        start(record);
        return { accepted: true };
      });
    },

    async inspect(operationId) {
      const record = await deps.store.get(operationId);
      if (!record) throw notFound('Administration operation', operationId);
      return record.job;
    },

    async recover() {
      await exclusive(async () => {
        for (const record of await deps.store.unfinished()) {
          const { command } = record;
          if (record.job.state === 'accepted') {
            // Accepted but not yet started: nothing has happened, so it may start now (a restart only if the
            // service is still the one the caller saw).
            try {
              await checkAcceptable(command);
            } catch (err) {
              await finish(record, 'failed', {
                errorCode: err instanceof DomainError ? err.code : 'administration_failed',
              });
              continue;
            }
            start(record);
            continue;
          }
          if (command.kind === 'restart' && deps.controller) {
            const probe = await deps.controller.probe().catch(() => null);
            if (probe?.running && probe.bootId && probe.bootId !== command.expectedBootId) {
              await log('restart_confirmed', { operationId: record.operationId, bootId: probe.bootId });
              await finish(record, 'succeeded', {
                result: { kind: 'restart', bootId: probe.bootId, version: deps.version ?? null },
              });
              continue;
            }
          }
          // Running when the previous run stopped, and nothing proves how it ended: never repeat it.
          await finish(record, 'unknown');
        }
      });
    },

    idle: async () => {
      await queue;
      await running;
    },

    async close() {
      closed = true;
      abort.abort();
      await running;
    },
  };
}
