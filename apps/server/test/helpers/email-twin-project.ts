import { OWNER, OWNER_ACTOR } from './domain-harness';
import type { DomainHarness } from './domain-harness';
import { withoutOnboarding } from './onboarding';

/**
 * A second project, BR, with the e-mail channel on and an AI member `dev-1` allowed to write: the same
 * handle as AR's, so neither member has an address (the handle is the address, PM-1039).
 */
export async function addTwinEmailProject(h: DomainHarness): Promise<void> {
  await withoutOnboarding(h.domain, () =>
    h.domain.projects.create(
      { key: 'BR', name: 'Fictional second project', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    ),
  );
  await h.domain.projects.update('BR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
    draft.project.email = { enabled: true };
    for (const member of draft.team.members)
      if (member.kind === 'ai' && member.handle === 'dev-1') member.email = { enabled: true };
    return 'Switch the e-mail channel on';
  });
}
