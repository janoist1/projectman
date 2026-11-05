import type { ProjectConfig } from '@projectman/shared';
import { EditBand } from '../edit/EditChrome';
import type { FieldIssue } from '../edit/FieldErrors';
import type { ElementEdit } from '../edit/useElementEdit';

/** The band over a panel's form; whoever saved first is shown by display name. */
export function PanelBands({
  edit,
  config,
  other,
}: {
  edit: Pick<ElementEdit<unknown>, 'gone' | 'conflict' | 'failure'>;
  config: ProjectConfig;
  /** The refused errors that belong to no field of the form. */
  other: readonly FieldIssue[];
}) {
  const author = edit.conflict?.author ?? '';
  const name = config.team.members.find((member) => member.handle === author)?.displayName ?? author;
  return <EditBand edit={edit} conflictName={name} other={other} />;
}
