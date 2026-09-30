import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { NewTaskDialog } from './NewTaskDialog';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('NewTaskDialog', () => {
  it('defaults to the workspace root when the project has several repos', async () => {
    const project = mockProject();
    project.render(<NewTaskDialog open onClose={() => {}} />);
    const repo = (await screen.findByLabelText(t('newTask.fields.repo'))) as HTMLSelectElement;
    await screen.findByRole('option', { name: /webshop/ });
    expect(repo.value).toBe('');
  });

  it('defaults to the only repo and still lets the user pick the workspace root', async () => {
    const project = mockProject();
    project.backend.config.project.repos = [{ name: 'shop', path: 'shop', defaultBranch: 'main' }];
    project.render(<NewTaskDialog open onClose={() => {}} />);
    const repo = (await screen.findByLabelText(t('newTask.fields.repo'))) as HTMLSelectElement;
    await waitFor(() => expect(repo.value).toBe('shop'));
    fireEvent.change(repo, { target: { value: '' } });
    expect(repo.value).toBe('');
  });
});
