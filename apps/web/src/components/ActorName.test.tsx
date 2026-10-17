import { fireEvent, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Actor } from '@projectman/shared';
import { renderUi } from '../test/render';
import { t } from '../i18n/t';
import { actorLabel } from '../lib/members';
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
      <ActorName actor={actor} members={new Map()} myHandle="actual-operator" projectKey="AC" />
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
