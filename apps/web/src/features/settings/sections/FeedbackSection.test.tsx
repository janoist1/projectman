import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../../api/client';
import { t } from '../../../i18n/t';
import { mockProject } from '../../../test/mockProject';
import { SettingsTestRoutes } from '../testRoutes';
import { surfaceIdFor } from './FeedbackSection';

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

describe('the slug of a surface', () => {
  it('turns a name into an ascii identifier and keeps it unique', () => {
    expect(surfaceIdFor('Admin felület', [])).toBe('admin-felulet');
    expect(surfaceIdFor('Admin felület', ['admin-felulet'])).toBe('admin-felulet-2');
    expect(surfaceIdFor('???', [])).toBe('surface');
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
    expect(body.feedback.surfaces).toEqual([
      { id: 'a1b2c3d4', name: 'Webshop', origin: 'https://acme.test' },
      { id: 'admin', name: 'Admin', origin: 'https://admin.acme.test' },
    ]);
    expect(await screen.findByText('https://admin.acme.test')).toBeTruthy();
  });

  it('removes a surface', async () => {
    const p = seeded();
    await section(p);
    fireEvent.click(
      screen.getByRole('button', { name: t('settings.feedback.surfaces.removeOf', { name: 'Webshop' }) }),
    );
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
