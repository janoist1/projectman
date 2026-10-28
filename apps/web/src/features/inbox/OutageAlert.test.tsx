import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WorkOutage } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/t';
import { outageHeading } from '../../lib/outage';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

/** The "work is stopped" alert (PM-468): provider and engine outages in "Rád vár". */

const since = '2026-10-08T08:00:00.000Z';
const ENGINE = { id: 'eng_abcdefghijkl', name: 'Mac mini' };
const claude: WorkOutage = {
  kind: 'provider',
  id: 'out_claude',
  provider: 'claude',
  problem: 'not_logged_in',
  engine: null,
  since,
};
const prefix = 'inbox.alerts.work_outage';
const loginCommand = t('providerSettings.loginCommands.claude');

function cardOf(outage: WorkOutage): HTMLElement {
  return screen.getByRole('heading', { name: outageHeading(outage) }).closest('article')!;
}

describe('the outage alert in the inbox (PM-468)', () => {
  it('asks for the Claude login: the heading, what stops, and the command to copy', async () => {
    const project = mockProject();
    project.backend.startOutage(claude, ['fe-1', 'be-1'], ['AC-24']);
    project.render(<InboxPage />, '/p/AC/inbox');

    await screen.findByRole('heading', { name: outageHeading(claude) });
    const card = cardOf(claude);
    expect(card.getAttribute('data-alert')).toBe('work_outage');
    expect(within(card).getByText(t(`${prefix}.todo.label`))).toBeTruthy();
    expect(within(card).getByText(loginCommand)).toBeTruthy();
    expect(within(card).getByText(t(`${prefix}.todo.login`))).toBeTruthy();
    expect(
      within(card).getByRole('button', { name: t(`${prefix}.todo.copyLabel`, { command: loginCommand }) }),
    ).toBeTruthy();
    expect(within(card).getByText(t(`${prefix}.selfClosing`))).toBeTruthy();
    expect(within(card).getByRole('button', { name: t('inbox.options.seen') })).toBeTruthy();
  });

  it('names the engine when the problem is on a remote one', async () => {
    const outage: WorkOutage = { ...claude, engine: ENGINE };
    const project = mockProject();
    project.backend.startOutage(outage, ['fe-1'], []);
    project.render(<InboxPage />, '/p/AC/inbox');

    await screen.findByRole('heading', { name: outageHeading(outage) });
    const card = cardOf(outage);
    expect(card.textContent).toContain(ENGINE.name);
    expect(within(card).getByText(t(`${prefix}.todo.loginOnEngine`, { engine: ENGINE.name }))).toBeTruthy();
  });

  it('sends a NanoGPT key problem to the settings, and an engine outage to the engines', async () => {
    const nano: WorkOutage = { ...claude, id: 'out_nano', provider: 'nanogpt', problem: 'no_key' };
    const engine: WorkOutage = { kind: 'engine', id: 'out_engine', engine: ENGINE, since };
    const project = mockProject();
    project.backend.startOutage(nano, ['dev-1'], []);
    project.backend.startOutage(engine, ['fe-1'], []);
    project.render(<InboxPage />, '/p/AC/inbox');

    await screen.findByRole('heading', { name: outageHeading(nano) });
    expect(
      within(cardOf(nano))
        .getByRole('link', { name: t(`${prefix}.todo.openSettings`) })
        .getAttribute('href'),
    ).toBe('/p/AC/settings/providers');
    expect(
      within(cardOf(engine))
        .getByRole('link', { name: t(`${prefix}.todo.manage`) })
        .getAttribute('href'),
    ).toBe('/p/AC/settings/engines');
    expect(cardOf(engine).textContent).toContain(ENGINE.name);
  });

  it('lists who cannot work and which cards wait, with the rest behind "+N további"', async () => {
    const handles = ['fe-1', 'be-1', 'dev-1', 'qa', 'devops', 'communication', 'code-review'];
    const cards = ['AC-24', 'AC-23', 'AC-22', 'AC-21', 'AC-20', 'AC-19', 'AC-18', 'AC-17'];
    const project = mockProject();
    project.backend.startOutage(claude, handles, cards);
    project.render(<InboxPage />, '/p/AC/inbox');

    await screen.findByRole('heading', { name: outageHeading(claude) });
    const card = cardOf(claude);
    const cardLinks = () => within(card).getAllByRole('link', { name: /AC-\d+/ });
    const memberLinks = () =>
      within(card)
        .getAllByRole('link')
        .filter((link) => /\/team\//.test(link.getAttribute('href') ?? ''));
    expect(cardLinks()).toHaveLength(6);
    expect(cardLinks()[0]!.getAttribute('href')).toBe('/p/AC/tasks/AC-24');
    expect(memberLinks()).toHaveLength(5);

    fireEvent.click(
      within(card).getByRole('button', { name: t(`${prefix}.affected.moreMembersLabel`, { count: 2 }) }),
    );
    expect(memberLinks()).toHaveLength(7);
    fireEvent.click(
      within(card).getByRole('button', { name: t(`${prefix}.affected.moreCardsLabel`, { count: 2 }) }),
    );
    expect(cardLinks()).toHaveLength(8);
  });

  it('says no card waits when none does', async () => {
    const project = mockProject();
    project.backend.startOutage(claude, ['fe-1'], []);
    project.render(<InboxPage />, '/p/AC/inbox');

    await screen.findByRole('heading', { name: outageHeading(claude) });
    expect(within(cardOf(claude)).getByText(t(`${prefix}.affected.noCards`))).toBeTruthy();
  });

  it('"Ellenőrzés most" asks the server, says it still stands, and the card goes once it is gone', async () => {
    const project = mockProject();
    const item = project.backend.startOutage(claude, ['fe-1'], ['AC-24']);
    project.render(<InboxPage />, '/p/AC/inbox');

    await screen.findByRole('heading', { name: outageHeading(claude) });
    fireEvent.click(within(cardOf(claude)).getByRole('button', { name: t(`${prefix}.checkNow`) }));
    expect(await screen.findByText(t(`${prefix}.stillFailing`))).toBeTruthy();
    expect(
      project.requests.filter(
        (request) => request.method === 'POST' && request.path === `/api/projects/AC/inbox/${item.id}/check`,
      ),
    ).toHaveLength(1);
    expect(screen.getByRole('heading', { name: outageHeading(claude) })).toBeTruthy();

    project.backend.outageRecovers = true;
    fireEvent.click(within(cardOf(claude)).getByRole('button', { name: t(`${prefix}.checkNow`) }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: outageHeading(claude) })).toBeNull());
    expect(project.backend.members.find((member) => member.handle === 'fe-1')?.outage).toBeUndefined();
    expect(project.backend.tasks.find((task) => task.key === 'AC-24')?.outage).toBeUndefined();
  });

  it('shows an outage that ended by itself among the closed ones, as ended by itself', async () => {
    const project = mockProject();
    const item = project.backend.startOutage(claude, ['fe-1'], []);
    project.backend.endOutage(item.id);
    project.render(<InboxPage />, '/p/AC/inbox');

    const history = await screen.findByRole('complementary');
    expect(await within(history).findByText(new RegExp(t('inbox.resolutions.outage_ended')))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t(`${prefix}.checkNow`) })).toBeNull();
  });
});
