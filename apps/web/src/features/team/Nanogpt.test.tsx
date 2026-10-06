import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { mockProject, createMockFetch } from '../../test/mockProject';
import { t } from '../../i18n/t';
import { formatDate } from '../../i18n/format';
import { HireDialog } from './HireDialog';
import { ProvidersSection } from '../settings/sections/ProvidersSection';
import { PermissionLevelControl } from './PermissionLevelControl';
import { EditMemberDialog } from './EditMemberDialog';
import { builtInRoles } from '../../mocks/fixtures';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const nanoRow = () => screen.getByText(t('providers.nanogpt'), { selector: 'strong' }).closest('li')!;

describe('NanoGPT UI', () => {
  it('consumes native cancellation without closing or submitting the parent hire dialog', async () => {
    const p = mockProject();
    const close = vi.fn();
    p.render(<HireDialog open onClose={close} config={p.backend.config} />);
    await screen.findByLabelText(t('providerSettings.provider'));
    change(t('providerSettings.provider'), 'nanogpt');
    fireEvent.click(await screen.findByRole('button', { name: t('nanogptKey.add') }));
    change(t('nanogptKey.field'), 'fictional-key');
    fireEvent(
      screen.getByRole('dialog', { name: t('nanogptKey.title') }),
      new Event('cancel', { bubbles: true, cancelable: true }),
    );
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: t('nanogptKey.title') })).toBeNull();
    expect(screen.getByRole('dialog', { name: t('hire.title') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.add') }));
    expect((screen.getByLabelText(t('nanogptKey.field')) as HTMLInputElement).value).toBe('');
  });
  it('keeps key and delete dialogs open on denied access and shows the code', async () => {
    const p = mockProject();
    p.render(<ProvidersSection config={p.backend.config} />);
    fireEvent.click(await screen.findByRole('button', { name: t('nanogptKey.add') }));
    p.backend.canManageKeys = false;
    change(t('nanogptKey.field'), 'fictional-key');
    fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.save') }));
    await screen.findByRole('alert');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(t('errors.code', { code: 'insufficient_access' }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    p.backend.canManageKeys = true;
    fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.add') }));
    change(t('nanogptKey.field'), 'fictional-key');
    fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.save') }));
    fireEvent.click(await screen.findByRole('button', { name: t('nanogptKey.deleteLabel') }));
    p.backend.canManageKeys = false;
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: t('nanogptKey.delete') }));
    await screen.findByRole('alert');
    expect(p.backend.nanogptKeyStatus.set).toBe(true);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('locks the field during save and preserves the dialog after a network failure', async () => {
    const p = mockProject();
    const fetch = createMockFetch(p.backend);
    let fail!: () => void;
    setFetchImplementation(async (path, init) => {
      if (init?.method === 'PUT') {
        await new Promise<void>((resolve) => {
          fail = resolve;
        });
        throw new Error('Fixture network failure');
      }
      return fetch(path, init);
    });
    p.render(<ProvidersSection config={p.backend.config} />);
    fireEvent.click(await screen.findByRole('button', { name: t('nanogptKey.add') }));
    change(t('nanogptKey.field'), 'fictional-key');
    fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.save') }));
    await waitFor(() =>
      expect((screen.getByLabelText(t('nanogptKey.field')) as HTMLInputElement).readOnly).toBe(true),
    );
    expect((screen.getByRole('button', { name: t('nanogptKey.saving') }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fail();
    await screen.findByText(t('errors.network'));
    expect(screen.getByText(t('errors.code', { code: 'network_error' }))).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('saves over a draft hire, validates and rejects keys, restores focus, and clears secrets on reopen', async () => {
    const p = mockProject();
    p.render(<HireDialog open onClose={() => {}} config={p.backend.config} />);
    await screen.findByLabelText(t('providerSettings.provider'));
    change(t('hire.displayName'), 'Draft developer');
    change(t('providerSettings.provider'), 'nanogpt');
    expect((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).value).toBe(
      'z-ai/glm-5.3-flash-uncensored',
    );
    const options = within(screen.getByLabelText(t('hire.model'))).getAllByRole('option');
    expect(options.map((option) => (option as HTMLOptionElement).value)).toEqual([
      'z-ai/glm-5.3-flash-uncensored',
      'z-ai/glm-5.3-uncensored',
      'z-ai/glm-5.3-flash-cybersecurity',
      'z-ai/glm-5.3',
      'deepseek/deepseek-v4-pro',
      'moonshotai/kimi-k2.7-code',
      'minimax/minimax-m3',
      'z-ai/glm-5.3-flash-apex-abliterated',
      'qwen/qwen3.8-27b-uncensored',
      'custom',
    ]);
    expect(options.map((option) => option.textContent)).toEqual([
      t('providerSettings.models.glm'),
      t('providerSettings.models.glmUncensored'),
      t('providerSettings.models.glmCybersecurity'),
      t('providerSettings.models.glmFull'),
      t('providerSettings.models.deepseekV4Pro'),
      t('providerSettings.models.kimiK27Code'),
      t('providerSettings.models.minimaxM3'),
      t('providerSettings.models.glmApexAbliterated'),
      t('providerSettings.models.qwenUncensored'),
      t('providerSettings.customModel'),
    ]);
    const add = await screen.findByRole('button', { name: t('nanogptKey.add') });
    add.focus();
    fireEvent.click(add);
    const dialog = screen.getByRole('dialog', { name: t('nanogptKey.title') });
    expect(dialog.closest('form')).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    const field = screen.getByLabelText(t('nanogptKey.field')) as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(document.activeElement).toBe(field);
    change(t('nanogptKey.field'), '  ');
    fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.save') }));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(t('nanogptKey.required'))).toBeTruthy();
    change(t('nanogptKey.field'), 'rejected');
    fireEvent.submit(field.closest('form')!);
    await screen.findByText(t('errors.codes.nanogpt_key_rejected'));
    expect(field.selectionEnd).toBe(field.value.length);
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(document.activeElement).toBe(add));
    fireEvent.click(add);
    expect((screen.getByLabelText(t('nanogptKey.field')) as HTMLInputElement).value).toBe('');
    change(t('nanogptKey.field'), 'fictional-private-key');
    fireEvent.submit(screen.getByLabelText(t('nanogptKey.field')).closest('form')!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('nanogptKey.title') })).toBeNull());
    const success = screen.getByRole('status');
    expect(success.textContent).toContain(t('nanogptKey.saved'));
    await waitFor(() => expect(document.activeElement).toBe(success));
    expect((screen.getByLabelText(t('hire.displayName')) as HTMLInputElement).value).toBe('Draft developer');
    expect(p.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('fictional-private-key');
    expect(JSON.stringify(localStorage)).not.toContain('fictional-private-key');
    expect(JSON.stringify(sessionStorage)).not.toContain('fictional-private-key');
    expect(p.requests.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/api/providers/nanogpt/key',
      body: { key: 'fictional-private-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    await waitFor(() =>
      expect(p.backend.config.team.members.at(-1)).toMatchObject({
        provider: 'nanogpt',
        displayName: 'Draft developer',
      }),
    );
  });

  it('adds, replaces and deletes in settings, focusing the surviving action and clearing mutation variables', async () => {
    const p = mockProject();
    const ui = p.render(<ProvidersSection config={p.backend.config} />);
    fireEvent.click(await screen.findByRole('button', { name: t('nanogptKey.add') }));
    change(t('nanogptKey.field'), 'first-private-key');
    fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.save') }));
    const replace = await screen.findByRole('button', { name: t('nanogptKey.replaceLabel') });
    await waitFor(() => expect(document.activeElement).toBe(replace));
    expect(nanoRow().textContent).toContain(
      t('providerSettings.nanogptSetAt', { date: formatDate(p.backend.nanogptKeyStatus.setAt!) }),
    );
    fireEvent.click(replace);
    expect(screen.getByRole('dialog', { name: t('nanogptKey.replaceTitle') })).toBeTruthy();
    change(t('nanogptKey.field'), 'second-private-key');
    fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.save') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.deleteLabel') }));
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: t('common.cancel') }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('nanogptKey.delete') }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: t('nanogptKey.add') })),
    );
    expect(p.backend.nanogptKeyStatus.set).toBe(false);
    expect(document.body.textContent).not.toContain('private-key');
    await waitFor(() =>
      expect(
        ui.client
          .getMutationCache()
          .getAll()
          .some((mutation) => typeof mutation.state.variables === 'string'),
      ).toBe(false),
    );
  });

  it.each(['cli_too_old', 'cli_missing', 'chatgpt_login'] as const)(
    'explains setup %s and still offers the missing key',
    async (problem) => {
      const p = mockProject();
      p.backend.providerStatus.nanogpt = {
        loggedIn: false,
        problem,
        cliVersion: '0.118.0',
        minCliVersion: '0.159.1',
      };
      p.render(<HireDialog open onClose={() => {}} config={p.backend.config} />);
      await screen.findByLabelText(t('providerSettings.provider'));
      change(t('providerSettings.provider'), 'nanogpt');
      const warning = await screen.findByRole('alert');
      expect(warning.textContent).toContain(
        t(`providerSettings.nanogptProblems.${problem}`, { cliVersion: '0.118.0', minCliVersion: '0.159.1' }),
      );
      fireEvent.click(within(warning).getByRole('button', { name: t('nanogptKey.add') }));
      change(t('nanogptKey.field'), 'test-key');
      fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.save') }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
      expect(screen.getByRole('alert').textContent).toContain(
        t('providerSettings.nanogptIncomplete', {
          reason: t(`providerSettings.nanogptProblems.${problem}`, {
            cliVersion: '0.118.0',
            minCliVersion: '0.159.1',
          }),
        }),
      );
    },
  );

  it.each(['cli_too_old', 'cli_missing', 'chatgpt_login', 'no_key', null] as const)(
    'renders provider row state %s without alerts',
    async (problem) => {
      const p = mockProject();
      p.backend.providerStatus.nanogpt = {
        loggedIn: problem ? false : null,
        problem: problem ?? undefined,
        cliVersion: '0.118.0',
        minCliVersion: '0.159.1',
      };
      p.render(<ProvidersSection config={p.backend.config} />);
      await screen.findByText(
        t(
          problem === null
            ? 'providerSettings.unknown'
            : problem === 'no_key'
              ? 'providerSettings.nanogptNoKeyState'
              : 'providerSettings.nanogptIncompleteState',
        ),
      );
      if (problem === 'chatgpt_login')
        expect(nanoRow().querySelector('code')?.textContent).toBe('providers/nanogpt/codex-home/auth.json');
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('explains missing keys without controls to viewers who cannot manage them', async () => {
    const p = mockProject();
    p.backend.canManageKeys = false;
    p.render(
      <>
        <ProvidersSection config={p.backend.config} />
        <HireDialog open onClose={() => {}} config={p.backend.config} />
      </>,
    );
    await screen.findByLabelText(t('providerSettings.provider'));
    change(t('providerSettings.provider'), 'nanogpt');
    await screen.findByText(t('providerSettings.nanogptOwnerSettings'), { exact: false });
    expect(screen.getByText(t('providerSettings.nanogptOwner'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('nanogptKey.add') })).toBeNull();
  });

  it.each([true, false])('explains the none approver on the profile for owner=%s', (isOwner) => {
    const p = mockProject();
    const member = p.backend.findMember('fe-1')!;
    p.render(<PermissionLevelControl member={{ ...member, provider: 'nanogpt', approver: 'none' }} />, '/', {
      isOwner,
    });
    expect(screen.getByText(t('permissionControls.nanogptApproverNone'))).toBeTruthy();
  });
  it('warns about none on an unsaved provider change and saves a custom NanoGPT model', async () => {
    const p = mockProject();
    const config = p.backend.config.team.members.find((member) => member.handle === 'fe-1')!;
    if (config.kind !== 'ai') throw new Error('Expected AI fixture');
    config.approver = 'none';
    p.backend.findMember('fe-1')!.approver = 'none';
    p.render(
      <EditMemberDialog
        member={p.backend.findMember('fe-1')!}
        config={p.backend.config}
        roles={builtInRoles}
        onClose={() => {}}
      />,
    );
    change(t('providerSettings.provider'), 'nanogpt');
    expect(screen.getByText(t('permissionControls.nanogptApproverNone'))).toBeTruthy();
    expect(config.provider).not.toBe('nanogpt');
    change(t('hire.model'), 'custom');
    expect(screen.getByText(t('providerSettings.nanogptModelHint'))).toBeTruthy();
    change(t('providerSettings.modelId'), 'custom/tool-model');
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(config).toMatchObject({ provider: 'nanogpt', model: 'custom/tool-model' }));
  });
  it('shows the none approver warning with the hire details closed', async () => {
    const p = mockProject();
    p.render(<HireDialog open onClose={() => {}} config={p.backend.config} />);
    await screen.findByLabelText(t('providerSettings.provider'));
    change(t('providerSettings.provider'), 'nanogpt');
    expect(screen.getByText(t('hire.nanogptApproverNone'), { exact: false }).closest('details')).toBeNull();
    expect(screen.getByText(t('hire.details')).closest('details')!.open).toBe(false);
  });
});
