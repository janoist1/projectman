import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { Task } from '@projectman/shared';
import type { AddableRelationKind, TaskRelationKind } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);

const kindName = (kind: TaskRelationKind) => t(`relations.kinds.${kind}`);
const section = () => screen.findByRole('region', { name: t('task.relations.title') });
const group = async (kind: TaskRelationKind) =>
  within(await section()).getByRole('group', { name: kindName(kind) });

/** Opens the "+" dialog of the card open in the drawer. */
async function openDialog() {
  fireEvent.click(within(await section()).getByRole('button', { name: t('task.relations.add') }));
  return screen.findByRole('dialog');
}
const chooseKind = (dialog: HTMLElement, kind: AddableRelationKind) =>
  fireEvent.click(within(dialog).getByRole('radio', { name: kindName(kind) }));
/** The candidate row of a card: found by typing its key in the search, as a person does. */
const optionOf = (dialog: HTMLElement, key: string) => {
  fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: key } });
  return within(dialog).getByRole('option', { name: (name) => name.startsWith(key) });
};
const chooseCard = (dialog: HTMLElement, key: string) => fireEvent.click(optionOf(dialog, key));
const submit = (dialog: HTMLElement, name: string = t('relationDialog.submit')) =>
  fireEvent.click(within(dialog).getByRole('button', { name }));

/** The PATCH requests to one card, parsed. */
const patches = (project: ReturnType<typeof mockProject>, key: string) =>
  project.requests.filter((r) => r.method === 'PATCH' && r.path === `/api/projects/AC/tasks/${key}`);

/** Adds a relation through the mock backend, as the server's PATCH would. */
const relate = (
  project: ReturnType<typeof mockProject>,
  key: string,
  kind: AddableRelationKind,
  to: string,
) =>
  project.backend.handle('PATCH', `/api/projects/AC/tasks/${key}`, {
    relations: { add: [{ kind, key: to }] },
  });

describe('relations in the drawer (PM-203)', () => {
  it('shows each kind in its group, from both sides of a relation, and a card opens on click', async () => {
    const project = mockProject();
    relate(project, 'AC-24', 'prerequisite', 'AC-17');
    relate(project, 'AC-24', 'related', 'AC-22');
    project.backend.updateTask('AC-23', { parentKey: 'AC-24' });
    project.render(drawer, '/p/AC/tasks/AC-24');

    const rows = (kind: TaskRelationKind) =>
      screen.findByRole('region', { name: t('task.relations.title') }).then((el) =>
        within(within(el).getByRole('group', { name: kindName(kind) }))
          .getAllByRole('link')
          .map((link) => link.getAttribute('href')),
      );
    expect(await rows('has_part')).toEqual(['/p/AC/tasks/AC-23']);
    expect(await rows('prerequisite')).toEqual(['/p/AC/tasks/AC-17']);
    expect(await rows('related')).toEqual(['/p/AC/tasks/AC-22']);
    expect(within(await section()).queryByRole('group', { name: kindName('duplicate_of') })).toBeNull();
    expect(within(await section()).getByText(t('task.relations.count', { count: 3 }))).toBeTruthy();
    // A row names the card's step, and the dot is its state.
    expect(within(await group('prerequisite')).getByText('Merge')).toBeTruthy();
  });

  it('says there are none on a card without relations', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    expect(within(await section()).getByText(t('task.relations.none'))).toBeTruthy();
  });

  describe('adding', () => {
    const cases: ReadonlyArray<{
      kind: AddableRelationKind;
      target: string;
      other: TaskRelationKind;
      preview: string;
    }> = [
      {
        kind: 'part_of',
        target: 'AC-20',
        other: 'has_part',
        preview: t('relationDialog.preview.part_of', { key: 'AC-20' }),
      },
      {
        kind: 'prerequisite',
        target: 'AC-17',
        other: 'prerequisite_of',
        preview: t('relationDialog.preview.prerequisite', { key: 'AC-17' }),
      },
      {
        kind: 'related',
        target: 'AC-22',
        other: 'related',
        preview: t('relationDialog.preview.related', { from: 'AC-24', key: 'AC-22' }),
      },
    ];
    it.each(cases)(
      '$kind: one PATCH with the kind and the card, and the other card shows it from its side',
      async ({ kind, target, other, preview }) => {
        const project = mockProject();
        project.render(drawer, '/p/AC/tasks/AC-24');
        const dialog = await openDialog();

        // No kind is chosen for the person: the direction is theirs to say.
        expect(within(dialog).queryByRole('radio', { checked: true })).toBeNull();
        expect(within(dialog).getByText(t('relationDialog.kindPrompt'))).toBeTruthy();
        expect(within(dialog).getByRole('button', { name: t('relationDialog.submit') })).toHaveProperty(
          'disabled',
          true,
        );

        chooseKind(dialog, kind);
        expect(within(dialog).getByText(t(`relationDialog.hints.${kind}`))).toBeTruthy();
        chooseCard(dialog, target);
        expect(within(dialog).getByText(preview)).toBeTruthy();
        submit(dialog);

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(patches(project, 'AC-24').map((r) => r.body)).toEqual([
          { relations: { add: [{ kind, key: target }] } },
        ]);
        expect(
          within(await group(kind))
            .getByRole('link', { name: new RegExp(target) })
            .getAttribute('href'),
        ).toBe(`/p/AC/tasks/${target}`);

        // The other card's drawer shows it from its side, with no request of its own.
        cleanup();
        project.render(drawer, `/p/AC/tasks/${target}`);
        expect(
          within(await group(other))
            .getByRole('link', { name: /AC-24/ })
            .getAttribute('href'),
        ).toBe('/p/AC/tasks/AC-24');
      },
    );

    it('duplicate_of: asks to confirm that the card closes, then closes it on the original', async () => {
      const project = mockProject();
      project.render(drawer, '/p/AC/tasks/AC-24');
      const dialog = await openDialog();
      chooseKind(dialog, 'duplicate_of');
      chooseCard(dialog, 'AC-20');
      // No second window: the warning and the confirming button are in the dialog.
      expect(within(dialog).getByText(t('relationDialog.preview.duplicate', { key: 'AC-20' }))).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: t('relationDialog.submit') })).toBeNull();
      expect(patches(project, 'AC-24')).toEqual([]);
      submit(dialog, t('relationDialog.submitDuplicate'));

      await waitFor(() => expect(project.backend.findTask('AC-24')!.status).toBe('cancelled'));
      expect(patches(project, 'AC-24').map((r) => r.body)).toEqual([
        { relations: { add: [{ kind: 'duplicate_of', key: 'AC-20' }] } },
      ]);
      expect(project.backend.findTask('AC-24')!.links).toContainEqual({ kind: 'duplicate_of', ref: 'AC-20' });
      // The card now shows the original, and its state says so.
      expect(await within(await group('duplicate_of')).findByRole('link', { name: /AC-20/ })).toBeTruthy();
      expect(
        (await screen.findAllByText(t('taskStatus.duplicateOf', { key: 'AC-20' }))).length,
      ).toBeGreaterThan(0);

      cleanup();
      project.render(drawer, '/p/AC/tasks/AC-20');
      expect(await within(await group('duplicated_by')).findByRole('link', { name: /AC-24/ })).toBeTruthy();
    });

    it('duplicate_of on a closed card only adds the relation, with no warning', async () => {
      const project = mockProject();
      project.render(drawer, '/p/AC/tasks/AC-16');
      const dialog = await openDialog();
      chooseKind(dialog, 'duplicate_of');
      chooseCard(dialog, 'AC-20');
      expect(within(dialog).getByText(t('relationDialog.preview.duplicateClosed'))).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: t('relationDialog.submitDuplicate') })).toBeNull();
      submit(dialog);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(project.backend.findTask('AC-16')).toMatchObject({
        status: 'done',
        links: expect.arrayContaining([{ kind: 'duplicate_of', ref: 'AC-20' }]),
      });
    });

    it('moves a card between collections in one request that removes and adds', async () => {
      const project = mockProject();
      project.backend.updateTask('AC-22', { parentKey: 'AC-20' });
      project.render(drawer, '/p/AC/tasks/AC-22');
      const dialog = await openDialog();
      chooseKind(dialog, 'part_of');
      expect(dialog.textContent).toContain(t('relationDialog.hintMove', { key: 'AC-20' }));
      chooseCard(dialog, 'AC-25');
      expect(dialog.textContent).toContain(t('relationDialog.preview.leaveParent', { key: 'AC-20' }));
      submit(dialog);
      await waitFor(() => expect(project.backend.findTask('AC-22')!.parentKey).toBe('AC-25'));
      expect(patches(project, 'AC-22').map((r) => r.body)).toEqual([
        {
          relations: {
            remove: [{ kind: 'part_of', key: 'AC-20' }],
            add: [{ kind: 'part_of', key: 'AC-25' }],
          },
        },
      ]);
    });

    it('disables what the shared rules refuse, with the reason under the row', async () => {
      const project = mockProject();
      // AC-23 already waits for AC-17; AC-22 is a duplicate of AC-20; AC-24 is related to AC-26.
      relate(project, 'AC-22', 'duplicate_of', 'AC-20');
      relate(project, 'AC-24', 'related', 'AC-26');
      project.render(drawer, '/p/AC/tasks/AC-17');
      let dialog = await openDialog();
      chooseKind(dialog, 'prerequisite');
      // AC-17 needing AC-23 would be a loop through AC-23's own prerequisite, AC-17.
      const loop = optionOf(dialog, 'AC-23');
      expect(loop.getAttribute('aria-disabled')).toBe('true');
      expect(
        within(loop).getByText(t('relationDialog.why.cycle', { path: 'AC-17 → AC-23 → AC-17' })),
      ).toBeTruthy();
      fireEvent.click(loop);
      expect(within(dialog).getByRole('button', { name: t('relationDialog.submit') })).toHaveProperty(
        'disabled',
        true,
      );
      expect(within(dialog).getByText(t('relationDialog.preview.pickCard'))).toBeTruthy();

      cleanup();
      project.render(drawer, '/p/AC/tasks/AC-24');
      dialog = await openDialog();
      chooseKind(dialog, 'duplicate_of');
      expect(
        within(optionOf(dialog, 'AC-22')).getByText(
          t('relationDialog.why.duplicateOfDuplicate', { key: 'AC-20' }),
        ),
      ).toBeTruthy();
      chooseKind(dialog, 'related');
      expect(within(optionOf(dialog, 'AC-26')).getByText(t('relationDialog.why.exists'))).toBeTruthy();
    });

    it('turns off part-of on a collection and says why', async () => {
      const project = mockProject();
      project.backend.updateTask('AC-22', { parentKey: 'AC-20' });
      project.render(drawer, '/p/AC/tasks/AC-20');
      const dialog = await openDialog();
      chooseKind(dialog, 'part_of');
      expect(within(dialog).getByText(t('relationDialog.off.part_of'))).toBeTruthy();
      expect(within(dialog).queryByRole('combobox')).toBeNull();
    });

    it('turns off what a theme cannot have: part-of, prerequisite and a subtask', async () => {
      const project = mockProject();
      const theme = Task.parse(
        project.backend.handle('POST', '/api/projects/AC/tasks', { title: 'Epic', kind: 'theme' }).body,
      );
      project.render(drawer, `/p/AC/tasks/${theme.key}`);
      const dialog = await openDialog();
      for (const kind of ['part_of', 'prerequisite'] as const)
        expect(
          within(dialog)
            .getByRole('radio', { name: kindName(kind) })
            .getAttribute('aria-disabled'),
        ).toBe('true');
      expect(
        within(dialog)
          .getByRole('radio', { name: t('relationDialog.newSubtask') })
          .getAttribute('aria-disabled'),
      ).toBe('true');
      expect(within(dialog).getByText(t('relationDialog.off.themePartOf'))).toBeTruthy();
      expect(within(dialog).getByText(t('relationDialog.off.themePrerequisite'))).toBeTruthy();
      expect(within(dialog).getByText(t('relationDialog.off.themeSubtask'))).toBeTruthy();
      chooseKind(dialog, 'related');
      expect(within(dialog).getByRole('combobox')).toBeTruthy();
    });

    it('names the card in the dialog and keeps the chosen card when a later search drops it', async () => {
      const project = mockProject();
      project.render(drawer, '/p/AC/tasks/AC-24');
      const dialog = await openDialog();
      expect(within(dialog).getByText(/^AC-24 · /)).toBeTruthy();
      chooseKind(dialog, 'related');
      chooseCard(dialog, 'AC-17');
      fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'AC-22' } });
      const keys = within(dialog)
        .getAllByRole('option')
        .map((option) => option.textContent!.slice(0, 5));
      expect(keys).toEqual(['AC-17', 'AC-22']);
      expect(
        within(dialog)
          .getByRole('option', { name: /^AC-17/ })
          .getAttribute('aria-selected'),
      ).toBe('true');
      expect(within(dialog).getByRole('button', { name: t('relationDialog.submit') })).toHaveProperty(
        'disabled',
        false,
      );
    });

    it('finds a card by key or by title, ignoring accents', async () => {
      const project = mockProject();
      project.render(drawer, '/p/AC/tasks/AC-24');
      const dialog = await openDialog();
      chooseKind(dialog, 'related');
      const search = within(dialog).getByRole('combobox');
      fireEvent.change(search, { target: { value: 'AC-17' } });
      expect(
        within(dialog)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual([expect.stringContaining('AC-17')]);
      fireEvent.change(search, { target: { value: 'hibariasztas' } });
      // The card itself is never offered for itself.
      expect(within(dialog).queryAllByRole('option')).toEqual([]);
      expect(within(dialog).getByText(t('relationDialog.noMatch'))).toBeTruthy();
      fireEvent.change(search, { target: { value: 'kartyas fizetes' } });
      expect(within(dialog).getAllByRole('option')).toHaveLength(1);
    });

    it('saves from the keyboard: arrows and Enter choose, Enter again saves', async () => {
      const project = mockProject();
      project.render(drawer, '/p/AC/tasks/AC-24');
      const dialog = await openDialog();
      chooseKind(dialog, 'related');
      const search = within(dialog).getByRole('combobox');
      fireEvent.change(search, { target: { value: 'AC-17' } });
      fireEvent.keyDown(search, { key: 'ArrowDown' });
      fireEvent.keyDown(search, { key: 'Enter' });
      expect(patches(project, 'AC-24')).toEqual([]);
      fireEvent.keyDown(search, { key: 'Enter' });
      await waitFor(() => expect(patches(project, 'AC-24')).toHaveLength(1));
    });

    it('says why the server refused, naming the cards of a loop, and keeps the dialog open', async () => {
      const project = mockProject();
      project.render(drawer, '/p/AC/tasks/AC-17');
      const dialog = await openDialog();
      chooseKind(dialog, 'prerequisite');
      chooseCard(dialog, 'AC-24');
      // Someone else made AC-24 wait for AC-17 after the board was loaded.
      relate(project, 'AC-24', 'prerequisite', 'AC-17');
      submit(dialog);
      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).toContain(t('errors.codes.relation_cycle'));
      expect(alert.textContent).toContain(t('relationDialog.cyclePath', { path: 'AC-17 → AC-24 → AC-17' }));
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(project.backend.findTask('AC-17')!.links.some((l) => l.ref === 'AC-24')).toBe(false);
    });

    it('says why an actor may not close a started card as a duplicate', async () => {
      const project = mockProject();
      // A developer who is not an admin may close a card that has not started, not one that has.
      project.backend.members.push({
        ...project.backend.members.find((member) => member.handle === 'owner')!,
        handle: 'dora',
        displayName: 'Dóra',
        role: 'developer',
        roles: [],
      });
      project.backend.viewerHandle = 'dora';
      project.render(drawer, '/p/AC/tasks/AC-20', { myHandle: 'dora' });
      const dialog = await openDialog();
      chooseKind(dialog, 'duplicate_of');
      chooseCard(dialog, 'AC-22');
      submit(dialog, t('relationDialog.submitDuplicate'));
      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).toContain(t('errors.codes.duplicate_not_allowed'));
      expect(project.backend.findTask('AC-20')!.status).not.toBe('cancelled');
    });
  });

  describe('deleting', () => {
    const cases: ReadonlyArray<{ kind: AddableRelationKind; view: TaskRelationKind; target: string }> = [
      { kind: 'prerequisite', view: 'prerequisite', target: 'AC-17' },
      { kind: 'related', view: 'related', target: 'AC-22' },
      { kind: 'duplicate_of', view: 'duplicate_of', target: 'AC-20' },
      { kind: 'part_of', view: 'part_of', target: 'AC-25' },
    ];
    it.each(cases)(
      '$kind: asks first, then sends the view kind and the card',
      async ({ kind, view, target }) => {
        const project = mockProject();
        relate(project, 'AC-24', kind, target);
        project.render(drawer, '/p/AC/tasks/AC-24');
        const list = await group(view);
        fireEvent.click(
          within(list).getByRole('button', {
            name: t('task.relations.remove', { kind: kindName(view), key: target }),
          }),
        );
        // Nothing is sent until the confirmation.
        expect(within(list).getByText(t('task.relations.removeConfirm'))).toBeTruthy();
        expect(patches(project, 'AC-24')).toEqual([]);
        fireEvent.click(within(list).getByRole('button', { name: t('task.relations.removeAction') }));

        await waitFor(() =>
          expect(
            within(screen.getByRole('region', { name: t('task.relations.title') })).queryByRole('group', {
              name: kindName(view),
            }),
          ).toBeNull(),
        );
        expect(patches(project, 'AC-24').map((r) => r.body)).toEqual([
          { relations: { remove: [{ kind: view, key: target }] } },
        ]);
      },
    );

    it('deletes from the other card too, with the kind as that card sees it', async () => {
      const project = mockProject();
      relate(project, 'AC-24', 'prerequisite', 'AC-17');
      project.render(drawer, '/p/AC/tasks/AC-17');
      const list = await group('prerequisite_of');
      fireEvent.click(
        within(list).getByRole('button', {
          name: t('task.relations.remove', { kind: kindName('prerequisite_of'), key: 'AC-24' }),
        }),
      );
      fireEvent.click(within(list).getByRole('button', { name: t('task.relations.removeAction') }));
      await waitFor(() => expect(project.backend.findTask('AC-24')!.links).toEqual([]));
      // The row is gone with the focus it had: the "+" takes it.
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(screen.getByRole('region', { name: t('task.relations.title') })).getByRole('button', {
            name: t('task.relations.add'),
          }),
        ),
      );
      expect(patches(project, 'AC-17').map((r) => r.body)).toEqual([
        { relations: { remove: [{ kind: 'prerequisite_of', key: 'AC-24' }] } },
      ]);
    });

    it('says what follows the removal of the last open prerequisite, and Escape cancels', async () => {
      const project = mockProject();
      project.render(drawer, '/p/AC/tasks/AC-23');
      const list = await group('prerequisite');
      const cross = within(list).getByRole('button', {
        name: t('task.relations.remove', { kind: kindName('prerequisite'), key: 'AC-17' }),
      });
      fireEvent.click(cross);
      expect(within(list).getByText(t('task.relations.consequence.frees'))).toBeTruthy();
      fireEvent.keyDown(within(list).getByText(t('task.relations.removeConfirm')), { key: 'Escape' });
      expect(within(list).queryByText(t('task.relations.removeConfirm'))).toBeNull();
      expect(patches(project, 'AC-23')).toEqual([]);
      expect(document.activeElement).toBe(cross);
    });

    it('keeps the row and says so when the removal fails', async () => {
      const project = mockProject();
      project.render(drawer, '/p/AC/tasks/AC-23');
      const list = await group('prerequisite');
      fireEvent.click(
        within(list).getByRole('button', {
          name: t('task.relations.remove', { kind: kindName('prerequisite'), key: 'AC-17' }),
        }),
      );
      // The relation went away on its own meanwhile: the server refuses the removal.
      project.backend.updateTask('AC-23', { links: [] });
      fireEvent.click(within(list).getByRole('button', { name: t('task.relations.removeAction') }));
      expect((await within(list).findByRole('alert')).textContent).toBe(t('task.relations.removeFailed'));
      expect(within(list).getByRole('link', { name: /AC-17/ })).toBeTruthy();
      expect(within(list).getByRole('button', { name: t('task.relations.retry') })).toBeTruthy();
    });
  });

  it('folds a long group to five rows and a button for the rest', async () => {
    const project = mockProject();
    for (const key of ['AC-21', 'AC-22', 'AC-23', 'AC-25', 'AC-26', 'AC-19', 'AC-18'])
      project.backend.updateTask(key, { parentKey: 'AC-20' });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const list = await group('has_part');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(within(list).getByRole('button', { name: t('task.relations.showAll', { count: 7 }) }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
  });

  it('lets a client see only the cards it may see, and change nothing', async () => {
    const project = mockProject();
    // AC-21 is shared with the client; AC-20 is internal; AC-17 is shared.
    relate(project, 'AC-21', 'prerequisite', 'AC-20');
    relate(project, 'AC-21', 'prerequisite', 'AC-17');
    relate(project, 'AC-21', 'related', 'AC-24');
    project.backend.viewerHandle = 'kata';
    project.render(drawer, '/p/AC/tasks/AC-21', {
      myHandle: 'kata',
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    const list = await group('prerequisite');
    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/p/AC/tasks/AC-17']);
    const all = await section();
    expect(within(all).queryByRole('group', { name: kindName('related') })).toBeNull();
    expect(all.textContent).not.toMatch(/AC-20|AC-24/);
    expect(within(all).queryByRole('button', { name: t('task.relations.add') })).toBeNull();
    expect(within(all).queryByRole('button', { name: /×|törlése/i })).toBeNull();
  });
});
