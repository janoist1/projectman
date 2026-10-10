import { screen, within } from '@testing-library/react';
import type { WorkOutage } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { outageReason } from '../../lib/outage';
import { mockProject } from '../../test/mockProject';
import { TeamPage } from './TeamPage';

/** A member who cannot work because of an outage (PM-468): "Nem tud dolgozni", with the reason. */

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function phone(mobile: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: mobile,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));
}

const claude: WorkOutage = {
  kind: 'provider',
  id: 'out_claude',
  provider: 'claude',
  problem: 'not_logged_in',
  engine: null,
  since: '2026-10-08T08:00:00.000Z',
};

describe('the roster with an outage', () => {
  it('reads "Nem tud dolgozni" with the reason under it on the table, in the orange tone', async () => {
    phone(false);
    const project = mockProject();
    project.backend.startOutage(claude, ['fe-1'], []);
    project.render(<TeamPage />);

    const row = (await screen.findByText(t('memberStatus.cannotWork'))).closest('tr')!;
    expect(within(row).getByText(outageReason(claude))).toBeTruthy();
    expect(row.querySelector('[data-status="cannot_work"]')).not.toBeNull();
    // Only the member with the outage reads it; the others keep their state.
    expect(screen.getAllByText(t('memberStatus.cannotWork'))).toHaveLength(1);
  });

  it('puts the reason on the status line of a phone card', async () => {
    phone(true);
    const project = mockProject();
    project.backend.startOutage(claude, ['fe-1'], []);
    project.render(<TeamPage />);

    const text = t('memberStatus.cannotWorkWithReason', { reason: outageReason(claude) });
    const line = await screen.findByText(text);
    expect(line.closest('[data-status="cannot_work"]')).not.toBeNull();
  });

  it('reads it for an idle member too, not "Pihen"', async () => {
    phone(false);
    const project = mockProject();
    project.backend.startOutage(claude, ['fe-1'], []);
    project.backend.findMember('fe-1')!.status = 'idle';
    project.render(<TeamPage />);

    expect(await screen.findByText(t('memberStatus.cannotWork'))).toBeTruthy();
  });

  it('is gone from the roster once the outage ends', async () => {
    phone(false);
    const project = mockProject();
    const item = project.backend.startOutage(claude, ['fe-1'], []);
    project.backend.endOutage(item.id);
    project.render(<TeamPage />);

    await screen.findByText(t('team.columns.status'));
    expect(screen.queryByText(t('memberStatus.cannotWork'))).toBeNull();
  });
});
