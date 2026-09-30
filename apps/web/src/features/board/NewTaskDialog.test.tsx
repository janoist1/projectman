import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { NewTaskDialog } from './NewTaskDialog';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('NewTaskDialog', () => {
  it('defaults to no repo when the project has several repos', async () => {
    const project = mockProject();
    project.render(<NewTaskDialog open onClose={() => {}} />);
    const repo = (await screen.findByLabelText(t('newTask.fields.repo'))) as HTMLSelectElement;
    await screen.findByRole('option', { name: /webshop/ });
    expect(repo.value).toBe('');
    expect(screen.getByRole('option', { name: t('newTask.fields.repoNone') })).toBe(repo.options[0]);
  });

  it('defaults to the only repo and still lets the user pick no repo', async () => {
    const project = mockProject();
    project.backend.config.project.repos = [{ name: 'shop', path: 'shop', defaultBranch: 'main' }];
    project.render(<NewTaskDialog open onClose={() => {}} />);
    const repo = (await screen.findByLabelText(t('newTask.fields.repo'))) as HTMLSelectElement;
    await waitFor(() => expect(repo.value).toBe('shop'));
    fireEvent.change(repo, { target: { value: '' } });
    expect(repo.value).toBe('');
  });
});

describe('new task description', () => {
  it('uses the shared editor and saves formatted markdown with the existing fields', async () => {
    const project = mockProject();
    project.backend.config.project.repos = [{ name: 'example', path: 'example', defaultBranch: 'main' }];
    project.render(<NewTaskDialog open onClose={() => {}} />);
    await screen.findByRole('option', { name: 'example' });
    fireEvent.change(screen.getByLabelText(t('newTask.fields.title')), { target: { value: 'Example task' } });
    const input = screen.getByLabelText(t('newTask.fields.description')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Example description' } });
    input.setSelectionRange(0, 7);
    fireEvent.click(screen.getByRole('button', { name: t('editor.bold') }));
    expect(input.value).toBe('**Example** description');
    fireEvent.click(screen.getByRole('button', { name: t('editor.preview') }));
    expect(
      screen.getByRole('region', { name: t('editor.preview') }).querySelector('strong')?.textContent,
    ).toBe('Example');
    fireEvent.change(screen.getByLabelText(t('newTask.fields.labels'), { exact: false }), {
      target: { value: 'example, bug' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('newTask.submit') }));
    await waitFor(() =>
      expect(project.backend.tasks.find((task) => task.title === 'Example task')).toMatchObject({
        description: '**Example** description',
        repo: 'example',
        labels: ['example', 'bug'],
        visibility: 'internal',
      }),
    );
  });
});
