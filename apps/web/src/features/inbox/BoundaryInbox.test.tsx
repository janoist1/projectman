import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockProject } from '../../test/mockProject';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { boundaryInboxFixture } from '../../mocks/boundary-fixture';
import { InboxPage } from './InboxPage';

describe('boundary inbox', () => {
  afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
  it('uses the narrow endpoint, attributes the decision and lets the owner revoke', async () => {
    const project = mockProject();
    project.backend.inbox = [boundaryInboxFixture()];
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('boundary.heading') });
    fireEvent.click(screen.getByRole('button', { name: t('inbox.options.allow') }));
    await waitFor(() => expect(project.backend.inbox[0]?.resolution?.by).toBe('owner'));
    expect(project.requests.some((r) => r.path.endsWith('/boundary/bnd_fixture/decide'))).toBe(true);
    expect(project.requests.some((r) => r.path.endsWith('/inbox/bnd_fixture/resolve'))).toBe(false);
    expect(project.backend.handle('GET', '/api/projects/AC/boundary/bnd_fixture', undefined)).toMatchObject({
      status: 200,
      body: { grant: { state: 'active', decidedBy: { kind: 'human', handle: 'owner' } } },
    });
    fireEvent.click(await screen.findByRole('button', { name: t('boundary.revoke') }));
    await waitFor(() => expect(project.backend.inbox[0]?.state).toBe('cancelled'));
    expect(project.backend.handle('GET', '/api/projects/AC/boundary/bnd_fixture', undefined)).toMatchObject({
      body: { request: { state: 'revoked' }, grant: { state: 'revoked' } },
    });
    expect(project.backend.timeline.filter((e) => e.type === 'boundary_changed').at(-1)?.actor.handle).toBe(
      'owner',
    );
  });
});
