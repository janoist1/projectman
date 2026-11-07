import { canDeleteMessageAttachment } from '@projectman/shared';
import type { MessageAttachmentRef, TeamMessage } from '@projectman/shared';
import { useDeleteMessageAttachment } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { AttachmentFiles } from './AttachmentFiles';

/** Shared bubble content for message files; refs remain visible after their bytes are deleted. */
export function MessageAttachments({
  files,
  from,
  sent = true,
}: {
  files: readonly MessageAttachmentRef[];
  from: TeamMessage['from'];
  sent?: boolean;
}) {
  const { key, me, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const access = me.projects.find((project) => project.key === key)?.access;
  const remove = useDeleteMessageAttachment(key);
  const canDelete = Boolean(
    sent &&
    access &&
    myHandle &&
    canDeleteMessageAttachment(
      { access, handle: myHandle },
      { uploadedBy: { kind: members.get(from)?.kind ?? 'human', handle: from } },
    ),
  );
  return (
    <AttachmentFiles
      files={files.map((file) => ({ ...file, gone: Boolean(file.goneAt) }))}
      projectKey={key}
      canDelete={canDelete}
      onDelete={(id) => remove.mutateAsync(id)}
      deleteConfirmKey="messageAttachments.deleteConfirm"
      focusFallback={(container) =>
        container
          ?.closest('[data-message-composer], #operator-panel')
          ?.querySelector<HTMLTextAreaElement>('textarea') ?? null
      }
    />
  );
}
