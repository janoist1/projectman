import type { SuperCommand } from '../api/super-handoff';
import type { ProjectManagerAgreementData } from '../domain/operator-knowledge';

/** Adds an owner question without changing the command's permissions or reserved effects. */
export function involvementAsksOwner(
  involvement: ProjectManagerAgreementData['involvement'],
  command: SuperCommand,
): boolean {
  return (
    involvement === 'every_step' &&
    command.kind === 'operate' &&
    ['config_patch', 'config_revert', 'member_update', 'member_hire', 'member_retire'].includes(
      command.operation.op,
    )
  );
}
