import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../../api/client';
import { t } from '../../../i18n/t';
import { createMockFetch, mockProject } from '../../../test/mockProject';
import { SettingsTestRoutes } from '../testRoutes';
import { newSurfaceId } from './FeedbackSection';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function seeded() {
  const p = mockProject();
  p.backend.feedback.seedSample();
  return p;
}

const patches = (p: ReturnType<typeof mockProject>) =>
  p.requests.filter((r) => r.method === 'PATCH' && r.path.endsWith('/config'));

async function section(p: ReturnType<typeof mockProject>) {
  p.render(<SettingsTestRoutes initialSection="feedback" />, '/p/AC/settings/feedback');
  return screen.findByText(t('settings.feedback.surfaces.title'));
}

describe('the identifier of a surface', () => {
  it('is eight lower case hex digits', () => {
    expect(newSurfaceId([])).toMatch(/^[0-9a-f]{8}$/);
  });

  it('differs from the existing ones', () => {
    const taken = Array.from({ length: 50 }, () => newSurfaceId([]));
    expect(taken).not.toContain(newSurfaceId(taken));
  });
});

describe('the feedback settings', () => {
  it('shows the line to build in, with the project key', async () => {
    const p = seeded();
    await section(p);
    const code = screen.getByText(/feedback\/widget\.js/);
    expect(code.textContent).toContain('https://projectman.acme.test/feedback/widget.js');
    expect(code.textContent).toContain('data-project="AC"');
  });

  it('copies the line to the clipboard', async () => {
    const p = seeded();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await section(p);
    fireEvent.click(screen.getByRole('button', { name: t('settings.feedback.embed.copy') }));
    expect(await screen.findByRole('button', { name: t('settings.feedback.embed.copied') })).toBeTruthy();
    expect(writeText.mock.calls[0]![0]).toContain('data-project="AC"');
  });

  it('refuses an address that is not a bare origin, and a missing name', async () => {
    const p = seeded();
    await section(p);
    const name = screen.getByLabelText(t('settings.feedback.surfaces.nameLabel'));
    const origin = screen.getByLabelText(t('settings.feedback.surfaces.originLabel'));
    const add = screen.getByRole('button', { name: t('settings.feedback.surfaces.add') });

    fireEvent.click(add);
    expect(await screen.findByText(t('settings.feedback.surfaces.nameError'))).toBeTruthy();
    expect(screen.getByText(t('settings.feedback.surfaces.urlError'))).toBeTruthy();

    fireEvent.change(name, { target: { value: 'Admin' } });
    fireEvent.change(origin, { target: { value: 'admin.acme.test' } });
    fireEvent.click(add);
    expect(await screen.findByText(t('settings.feedback.surfaces.urlError'))).toBeTruthy();

    fireEvent.change(origin, { target: { value: 'https://admin.acme.test/panel' } });
    fireEvent.click(add);
    expect(await screen.findByText(t('settings.feedback.surfaces.pathError'))).toBeTruthy();

    fireEvent.change(origin, { target: { value: 'http://admin.acme.test' } });
    fireEvent.click(add);
    expect(await screen.findByText(t('settings.feedback.surfaces.schemeError'))).toBeTruthy();

    fireEvent.change(origin, { target: { value: 'https://ACME.test/' } });
    fireEvent.click(add);
    expect(await screen.findByText(t('settings.feedback.surfaces.duplicate'))).toBeTruthy();

    fireEvent.change(name, { target: { value: 'x'.repeat(41) } });
    fireEvent.click(add);
    expect(await screen.findByText(t('settings.feedback.surfaces.nameTooLong', { max: 40 }))).toBeTruthy();
    expect(patches(p)).toHaveLength(0);
  });

  it('adds a surface next to the existing ones', async () => {
    const p = seeded();
    await section(p);
    fireEvent.change(screen.getByLabelText(t('settings.feedback.surfaces.nameLabel')), {
      target: { value: 'Admin' },
    });
    fireEvent.change(screen.getByLabelText(t('settings.feedback.surfaces.originLabel')), {
      target: { value: 'https://admin.acme.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('settings.feedback.surfaces.add') }));
    await waitFor(() => expect(patches(p)).toHaveLength(1));
    const body = patches(p)[0]!.body as {
      feedback: { surfaces: { id: string; name: string; origin: string }[] };
    };
    expect(body.feedback.surfaces).toHaveLength(2);
    expect(body.feedback.surfaces[0]).toEqual({
      id: 'a1b2c3d4',
      name: 'Webshop',
      origin: 'https://acme.test',
    });
    expect(body.feedback.surfaces[1]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      name: 'Admin',
      origin: 'https://admin.acme.test',
    });
    expect(await screen.findByText('https://admin.acme.test')).toBeTruthy();
  });

  it('removes a surface only after a confirmation', async () => {
    const p = seeded();
    await section(p);
    fireEvent.click(
      screen.getByRole('button', { name: t('settings.feedback.surfaces.removeOf', { name: 'Webshop' }) }),
    );
    const dialog = await screen.findByRole('dialog', { name: t('settings.feedback.surfaces.removeTitle') });
    expect(within(dialog).getByText(/A korábbi jelölések megmaradnak/)).toBeTruthy();
    expect(patches(p)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.feedback.surfaces.remove') }));
    await waitFor(() => expect(patches(p)).toHaveLength(1));
    expect((patches(p)[0]!.body as { feedback: unknown }).feedback).toEqual({ surfaces: [] });
    expect(await screen.findByText(t('settings.feedback.surfaces.none'))).toBeTruthy();
  });

  it('switches marking off for a member and back on', async () => {
    const p = seeded();
    await section(p);
    const toggle = await screen.findByRole('switch', {
      name: t('settings.feedback.markers.canMarkOf', { name: 'Kata' }),
    });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(patches(p)).toHaveLength(1));
    expect((patches(p)[0]!.body as { feedback: unknown }).feedback).toEqual({ blockedMarkers: ['kata'] });
    await waitFor(() =>
      expect(
        (
          screen.getByRole('switch', {
            name: t('settings.feedback.markers.canMarkOf', { name: 'Kata' }),
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole('switch', { name: t('settings.feedback.markers.canMarkOf', { name: 'Kata' }) }),
    );
    await waitFor(() => expect(patches(p)).toHaveLength(2));
    expect((patches(p)[1]!.body as { feedback: unknown }).feedback).toEqual({ blockedMarkers: [] });
  });

  it('shows a viewer with the switch off and disabled', async () => {
    const p = seeded();
    const kata = p.backend.config.team.members.find((member) => member.handle === 'kata');
    if (kata?.kind === 'human') kata.access = 'viewer';
    await section(p);
    const toggle = (await screen.findByRole('switch', {
      name: t('settings.feedback.markers.canMarkOf', { name: 'Kata' }),
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(t('settings.feedback.markers.viewer'))).toBeTruthy();
  });

  it('names the address the page may allow in its content security policy', async () => {
    const p = seeded();
    await section(p);
    expect(
      screen.getByText(t('settings.feedback.embed.csp', { address: 'https://projectman.acme.test' })),
    ).toBeTruthy();
  });

  it('shows a failed save with a way to try again', async () => {
    const p = seeded();
    await section(p);
    fireEvent.change(screen.getByLabelText(t('settings.feedback.surfaces.nameLabel')), {
      target: { value: 'Admin' },
    });
    fireEvent.change(screen.getByLabelText(t('settings.feedback.surfaces.originLabel')), {
      target: { value: 'https://admin.acme.test' },
    });
    const mock = createMockFetch(p.backend, p.requests);
    let failing = true;
    setFetchImplementation((input, init) =>
      failing && init?.method === 'PATCH'
        ? Promise.resolve(new Response('{}', { status: 500 }))
        : mock(input, init),
    );
    fireEvent.click(screen.getByRole('button', { name: t('settings.feedback.surfaces.add') }));
    expect(await screen.findByText(t('settings.feedback.surfaces.saveFailed'))).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: t('app.retry') }));
    await waitFor(() => expect(patches(p)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(t('settings.feedback.surfaces.saveFailed'))).toBeNull());
  });

  it('logs a member out of their browsers only after a confirmation', async () => {
    const p = seeded();
    await section(p);
    fireEvent.click(
      await screen.findByRole('button', { name: t('settings.feedback.markers.logoutOf', { name: 'Kata' }) }),
    );
    const dialog = await screen.findByRole('dialog', { name: t('settings.feedback.markers.logoutTitle') });
    expect(
      p.requests.filter((r) => r.method === 'POST' && r.path.includes('/feedback/markers/')),
    ).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.feedback.markers.logout') }));
    await waitFor(() =>
      expect(
        p.requests.filter((r) => r.method === 'POST' && r.path.includes('/feedback/markers/')),
      ).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('names the member who processes the marks', async () => {
    const p = seeded();
    await section(p);
    expect(screen.getByText(/Most: .*\(pm\)/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: t('settings.feedback.processor.link') }).getAttribute('href'),
    ).toBe('/p/AC/settings/duties');
  });

  it('does not offer the section to a member who cannot manage the team', async () => {
    const p = seeded();
    p.render(<SettingsTestRoutes initialSection="feedback" />, '/p/AC/settings/feedback', {
      isOwner: false,
      can: { createTasks: true, manageTeam: false, workInSessions: true },
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(t('settings.feedback.surfaces.title'))).toBeNull();
  });
});
