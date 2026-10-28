import type { JournalFailureCode } from './journal';
import type { FixedFailure } from './ports';

/**
 * The only texts the coordinator ever sends to the cloud, the journal or the owner's alert (PM-751). They are
 * fixed per code: a raw error, a command line, a path or an AWS answer never goes into one (the server stores
 * what it is sent and shows it to the approvers).
 */
export const FAILURES: Record<JournalFailureCode, FixedFailure> = {
  prepare_failed: {
    step: 'build',
    message: 'The release could not be prepared or its preparation did not verify; nothing was changed.',
  },
  quiesce_refused: { step: 'pause', message: 'The cloud refused to pause the work; nothing was changed.' },
  drain_timeout: {
    step: 'pause',
    message: 'The running work did not finish in time; nothing was changed and the work continues.',
  },
  switch_refused: { step: 'switch', message: 'The cloud refused the switch; nothing was changed.' },
  cloud_import_failed: {
    step: 'switch',
    message: 'The cloud could not take the new image; the previous program runs again.',
  },
  cloud_start_failed: {
    step: 'switch',
    message: 'The cloud did not start the new image; the previous program runs again.',
  },
  cloud_verify_failed: {
    step: 'verify',
    message: 'The new cloud program did not become healthy; the previous program runs again.',
  },
  engine_start_failed: {
    step: 'switch',
    message: 'The engine could not be started on the new program; the previous program runs again.',
  },
  engine_verify_failed: {
    step: 'verify',
    message: 'The new engine did not connect on the new program; the previous program runs again.',
  },
  live_refused: {
    step: 'verify',
    message: 'The cloud did not accept both targets as live; the previous program runs again.',
  },
  release_deployment_conflict: {
    step: 'verify',
    message: 'The deployment is not in the state the coordinator expects; a person must look at it.',
  },
  release_target_mismatch: {
    step: 'verify',
    message: 'The targets do not run the program the coordinator expects; a person must look at it.',
  },
  release_pause_conflict: {
    step: 'verify',
    message: 'The pause of the deployment is not the one the coordinator holds; a person must look at it.',
  },
  release_not_drained: {
    step: 'verify',
    message: 'The work could not be shown to be finished; a person must look at it.',
  },
  release_recovery_required: {
    step: 'verify',
    message: 'The deployment already needs recovery; a person must look at it.',
  },
  release_protocol_unavailable: {
    step: 'verify',
    message: 'The cloud does not take the hybrid release protocol; a person must look at it.',
  },
  release_artifact_changed: {
    step: 'verify',
    message: 'The prepared image changed after it was bound; a person must look at it.',
  },
  release_engine_mismatch: {
    step: 'verify',
    message: 'The engine does not run the program the coordinator expects; a person must look at it.',
  },
  cloud_transport_failed: {
    step: 'switch',
    message:
      'The state of the cloud machine could not be told after a lost answer; a person must look at it.',
  },
  engine_switch_failed: {
    step: 'switch',
    message: 'The state of the engine could not be proven during the switch; a person must look at it.',
  },
  rollback_failed: {
    step: 'rollback',
    message: 'The previous program could not be shown to run again; a person must look at it.',
  },
  database_incompatible: {
    step: 'rollback',
    message:
      'The database schema is newer than the previous program or unknown: there is no automatic rollback and no data restore; a person must decide.',
  },
};

/** The failure of a publish: the tag or the GitHub release could not be made. */
export const PUBLISH_FAILED_MESSAGE =
  'The release is live, but the tag or the GitHub release could not be created; it is tried again later.';
