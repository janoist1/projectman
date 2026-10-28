import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { connectedActorOf } from '@projectman/shared';
import type { Actor } from '@projectman/shared';
import { renderUi } from '../test/render';
import { t } from '../i18n/t';
import { actorLabel, indexMembers } from '../lib/members';
import { members as fixtureMembers } from '../mocks/fixtures';
import { ActorName } from './ActorName';
import { Avatar } from './Avatar';

const actor: Actor = {
  kind: 'ai',
  handle: 'actual-operator',
  via: 'integrator',
  operatorMode: 'super',
  credential: { id: 'credential', prefix: 'pmi_test' },
};

it('distinguishes super and historical owner actors and exposes only the credential prefix', () => {
  renderUi(
    <>
      <ActorName
        actor={actor}
        members={new Map()}
        myHandle="actual-operator"
        projectKey="AC"
        machineOperation
      />
      <Avatar actor={actor} member={undefined} via="integrator" label="operator" />
      <ActorName
        actor={{ kind: 'human', handle: 'owner', via: 'integrator' }}
        members={new Map()}
        myHandle="owner"
        projectKey="AC"
      />
    </>,
  );
  expect(screen.getByText(t('involvement.integratorFull'))).toBeTruthy();
  expect(screen.queryByText(t('common.you'))).toBeNull();
  expect(screen.queryByText('pmi_test…')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('superMode.badge') }));
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('pmi_test…')).toBeTruthy();
  expect(screen.getByRole('link').getAttribute('href')).toBe('/p/AC/sessions?by=super&prefix=pmi_test');
  expect(screen.getByRole('img', { name: t('superMode.avatar') }).getAttribute('data-tone')).toBe('operator');
  expect(actorLabel(actor, new Map(), 'actual-operator')).toBe(t('superMode.actor'));
});

describe('a connected Claude step (decision 66)', () => {
  const credential = { id: 'cred_internal_id', prefix: 'pmk_7Hq2' };
  const members = indexMembers(fixtureMembers);
  const direct = connectedActorOf('kata', credential);
  const external = connectedActorOf('kata', credential, { issuer: 'devops' });
  const approved = connectedActorOf('kata', credential, { issuer: 'devops', approvedBy: 'bence' });
  const renderActor = (actor: Actor, extra: { showApproval?: boolean; history?: boolean } = {}) =>
    renderUi(<ActorName actor={actor} members={members} myHandle="owner" projectKey="AC" {...extra} />);

  it.each([
    { name: 'a direct instruction', actor: direct, who: 'Kata', chip: t('connected.chip') },
    {
      name: 'external work (MCP)',
      actor: external,
      who: 'Devops',
      chip: t('connected.chipHolder', { holder: 'Kata' }),
    },
  ])('draws $name as the name and a chip button, not as the old integrator', ({ actor, who, chip }) => {
    renderActor(actor);
    expect(screen.getByText(who)).toBeTruthy();
    expect(screen.getByText(chip)).toBeTruthy();
    expect(screen.getByRole('button', { name: t('connected.chipAria', { holder: 'Kata' }) })).toBeTruthy();
    expect(screen.queryByText(t('involvement.integratorFull'))).toBeNull();
  });

  it('shows the approver next to the chip, or only in the detail with showApproval off', () => {
    const view = renderActor(approved);
    const approval = t('connected.approvedBy', { name: 'Bence' });
    expect(screen.getByText(approval, { exact: false })).toBeTruthy();
    view.unmount();
    renderActor(approved, { showApproval: false });
    expect(screen.queryByText(approval, { exact: false })).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(approval, { exact: false })).toBeTruthy();
  });

  it('opens the key prefix and the activity link on click, and never shows the credential id', () => {
    const { container } = renderActor(approved);
    expect(screen.queryByText(`${credential.prefix}…`)).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(`${credential.prefix}…`)).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      `/p/AC/sessions?by=super&prefix=${credential.prefix}`,
    );
    expect(container.textContent).not.toContain(credential.id);
  });

  it('keeps the detail open without a button in history mode', () => {
    renderActor(approved, { history: true });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(`${credential.prefix}…`)).toBeTruthy();
  });

  it('draws the avatar of the member itself with the plug badge, not the operator one', () => {
    renderUi(<Avatar actor={external} member={members.get('devops')} handle="devops" label="Devops" />);
    const avatar = screen.getByRole('img', { name: t('connected.avatar', { name: 'Devops' }) });
    expect(avatar.getAttribute('data-tone')).not.toBe('operator');
  });
});
