import type { AiMemberConfig, ProjectConfig } from './schema';

/**
 * The name under which an AI member's state is kept on disk and on the engine (workspace, `.home`,
 * sandbox cache, memory file): its oldest handle. It stays the same when the member is renamed,
 * so nothing moves and the agent's conversations keep their working directory (PM-1024).
 */
export function memberStorageHandle(member: Pick<AiMemberConfig, 'handle' | 'formerHandles'>): string {
  return member.formerHandles?.[0] ?? member.handle;
}

/**
 * The handle a name stands for now (PM-1025): the handle itself when a member bears it, the current
 * handle of the member that was once called that, otherwise null. A live handle wins over a former one.
 */
export function currentHandleOf(config: Pick<ProjectConfig, 'team'>, handle: string): string | null {
  const members = config.team.members;
  if (members.some((member) => member.handle === handle)) return handle;
  const renamed = members.find((member) => member.kind === 'ai' && member.formerHandles?.includes(handle));
  return renamed?.handle ?? null;
}

/**
 * The configuration after the AI member `from` was renamed to `to` (PM-1025): every reference to the
 * handle follows and `from` joins the member's former handles; the member's address, being its
 * handle, becomes `<to>@<domain>`. The caller checked that the rename is allowed.
 */
export function renameMemberInConfig(config: ProjectConfig, from: string, to: string): ProjectConfig {
  const swap = (handle: string): string => (handle === from ? to : handle);
  const swapAll = (handles: readonly string[]): string[] => handles.map(swap);
  const feedback = config.project.feedback;
  const { cardMover, merger } = config.team;
  return {
    ...config,
    project: {
      ...config.project,
      ...(feedback ? { feedback: { ...feedback, blockedMarkers: swapAll(feedback.blockedMarkers) } } : {}),
    },
    team: {
      ...config.team,
      ...(cardMover?.kind === 'human' ? { cardMover: { ...cardMover, handle: swap(cardMover.handle) } } : {}),
      ...(merger?.kind === 'member' ? { merger: { ...merger, handle: swap(merger.handle) } } : {}),
      contacts: swapAll(config.team.contacts),
      members: config.team.members.map((member) => {
        if (member.kind !== 'ai') return member;
        if (member.handle !== from) return { ...member, sponsor: swap(member.sponsor) };
        return {
          ...member,
          handle: to,
          formerHandles: [...(member.formerHandles ?? []), from],
          sponsor: swap(member.sponsor),
        };
      }),
    },
    pipeline: {
      ...config.pipeline,
      stages: config.pipeline.stages.map((stage) =>
        stage.owners ? { ...stage, owners: swapAll(stage.owners) } : stage,
      ),
      labels: config.pipeline.labels.map((label) =>
        typeof label.setBy === 'object' && label.setBy.members
          ? { ...label, setBy: { ...label.setBy, members: swapAll(label.setBy.members) } }
          : label,
      ),
    },
  };
}
