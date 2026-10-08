import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { isTaskClosed } from '../../lib/taskState';
import { builtInRoles } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { EditMemberDialog } from './EditMemberDialog';

/** The edit dialog of a member of the mock project, inside the toasts. */
function renderEdit(handle: string, prepare: (project: ReturnType<typeof mockProject>) => void = () => {}) {
  const project = mockProject();
  prepare(project);
  project.render(
    <ToastProvider>
      <EditMemberDialog
        member={project.backend.findMember(handle)!}
        config={project.backend.config}
        roles={builtInRoles}
        onClose={() => {}}
      />
    </ToastProvider>,
  );
  return project;
}

const openCards = (project: ReturnType<typeof mockProject>, handle: string) =>
  project.backend.tasks.filter((task) => task.assignee === handle && !isTaskClosed(task)).length;

describe('the provider change of a member with open cards (PM-342)', () => {
  it('warns how many cards start a new conversation, and says so after the save', async () => {
    const project = renderEdit('be-1');
    const count = openCards(project, 'be-1');
    expect(count).toBeGreaterThan(0);
    const provider = await screen.findByLabelText(t('providerSettings.provider'));
    // No hint until the provider differs from the saved one.
    expect(screen.queryByText(t('handoff.member.hint', { count }))).toBeNull();
    fireEvent.change(provider, { target: { value: 'claude' } });
    await screen.findByText(t('handoff.member.hint', { count }));
    // Choosing the saved provider again takes the hint away.
    fireEvent.change(provider, { target: { value: 'codex' } });
    expect(screen.queryByText(t('handoff.member.hint', { count }))).toBeNull();
    fireEvent.change(provider, { target: { value: 'claude' } });
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await screen.findByText(t('handoff.member.saved', { count }));
    expect(screen.queryByText(t('memberEdit.saved'))).toBeNull();
  });

  it('keeps today’s toast, and no hint, for a member with no open card', async () => {
    renderEdit('qa', (project) => {
      for (const task of project.backend.tasks) if (task.assignee === 'qa') task.assignee = null;
    });
    const provider = await screen.findByLabelText(t('providerSettings.provider'));
    fireEvent.change(provider, { target: { value: 'gemini' } });
    expect(screen.queryByText(/kártyáján a következő indításkor/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await screen.findByText(t('memberEdit.saved'));
    await waitFor(() => expect(screen.queryByText(/új beszélgetés indul/)).toBeNull());
  });
});
