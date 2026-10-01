import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockProject } from '../../test/mockProject';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { boundaryInboxFixture } from '../../mocks/boundary-fixture';
import { InboxPage } from './InboxPage';
import { BoundaryRequest } from '@projectman/shared';

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
    await screen.findByText(t('boundary.states.revoked') + ' · ' + t('boundary.reasons.owner_revoked'));
    expect(project.backend.inbox[0]?.resolution).toMatchObject({
      optionId: 'allow',
      by: 'owner',
      note: 'scope_verified',
    });
    expect(project.backend.handle('GET', '/api/projects/AC/boundary/bnd_fixture', undefined)).toMatchObject({
      body: { request: { state: 'revoked' }, grant: { state: 'revoked' } },
    });
    expect(project.backend.timeline.filter((e) => e.type === 'boundary_changed').at(-1)?.actor.handle).toBe(
      'owner',
    );
  });
  it('shows a consumed approval with its original decision and no revocation button', async () => {
    const project = mockProject();
    const item = boundaryInboxFixture();
    const request = BoundaryRequest.parse(item.payload.boundary);
    request.state = 'allowed';
    request.consumedAt = request.createdAt;
    request.decidedBy = { kind: 'ai', handle: 'code-review' };
    request.reason = 'scope_verified';
    item.state = 'resolved';
    item.payload.boundary = request;
    item.resolution = { optionId: 'allow', by: 'code-review', note: 'scope_verified', at: request.createdAt };
    project.backend.inbox = [item];
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByText(t('boundary.consumed'));
    expect(screen.queryByRole('button', { name: t('boundary.revoke') })).toBeNull();
    expect(project.backend.inbox[0]?.resolution?.by).toBe('code-review');
  });
});
