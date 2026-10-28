import { AnswerHostRequestRequest, CreateOwnerInviteRequest } from '@projectman/shared';
import type { HostRequestView, OwnerAccountView, OwnerInvitationView } from '@projectman/shared';
import { mockId, nowIso } from './time';

interface MockResponse {
  status: number;
  body?: unknown;
}
function error(status: number, code: string): MockResponse {
  return { status, body: { error: { code, message: code, details: { category: 'members' } } } };
}

/** The host's account and request endpoints, without any project contents. */
export class MockOwners {
  invitations: OwnerInvitationView[] = [];
  accounts: OwnerAccountView[] = [];
  requests: HostRequestView[] = [];
  readonly calls: { method: string; path: string; body: unknown }[] = [];

  handle(
    method: string,
    path: string,
    body: unknown,
    query: URLSearchParams,
    rights: { hostOwner: boolean; ownLogin: boolean },
  ): MockResponse | null {
    const requestRoute = path === '/api/host-requests' || /^\/api\/host-requests\/[^/]+\/answer$/.test(path);
    const ownerRoute =
      path === '/api/owner-invitations' ||
      /^\/api\/owner-invitations\/[^/]+$/.test(path) ||
      path === '/api/owner-accounts' ||
      /^\/api\/owner-accounts\/[^/]+\/revoke$/.test(path);
    if (!requestRoute && !ownerRoute) return null;
    this.calls.push({ method, path, body });
    if (ownerRoute && !rights.ownLogin) return error(403, 'owner_login_required');
    if (!rights.hostOwner) return error(403, requestRoute ? 'host_only' : 'owner_only');
    const at = nowIso();
    if (path === '/api/owner-invitations') {
      if (method === 'GET') return { status: 200, body: { invitations: this.invitations } };
      if (method === 'POST') {
        const parsed = CreateOwnerInviteRequest.safeParse(body);
        if (!parsed.success) return error(400, 'invalid_request');
        if (
          this.accounts.some(
            (a) => a.revokedAt === null && a.email.toLowerCase() === parsed.data.email.toLowerCase(),
          )
        )
          return error(409, 'owner_account_exists');
        const invitation: OwnerInvitationView = {
          id: mockId('oinv'),
          email: parsed.data.email,
          invitedBy: 'Host',
          createdAt: at,
          expiresAt: new Date(Date.parse(at) + 7 * 86_400_000).toISOString(),
          acceptedAt: null,
          revokedAt: null,
        };
        this.invitations.push(invitation);
        return { status: 201, body: { ...invitation, path: `/owner-invite/mock_${invitation.id}` } };
      }
    }
    if (path.startsWith('/api/owner-invitations/') && method === 'DELETE') {
      const invitation = this.invitations.find((i) => i.id === path.split('/')[3]);
      if (!invitation) return error(404, 'not_found');
      if (invitation.acceptedAt) return error(409, 'invite_used');
      invitation.revokedAt = at;
      return { status: 204 };
    }
    if (path === '/api/owner-accounts' && method === 'GET')
      return { status: 200, body: { accounts: this.accounts } };
    if (path.startsWith('/api/owner-accounts/') && method === 'POST') {
      const account = this.accounts.find((a) => a.userId === path.split('/')[3]);
      if (!account) return error(404, 'not_found');
      Object.assign(account, {
        revokedAt: at,
        pausedProjectCount: account.projectCount,
        engines: { total: 0, online: 0 },
      });
      return { status: 200, body: account };
    }
    if (path === '/api/host-requests' && method === 'GET')
      return {
        status: 200,
        body: {
          requests: this.requests.filter((r) => !query.get('state') || r.state === query.get('state')),
        },
      };
    if (requestRoute && method === 'POST') {
      const parsed = AnswerHostRequestRequest.safeParse(body);
      if (!parsed.success) return error(400, 'invalid_request');
      const request = this.requests.find((r) => r.id === path.split('/')[3]);
      if (!request) return error(404, 'not_found');
      if (request.state !== 'open') return error(409, 'host_request_closed');
      Object.assign(request, {
        state: parsed.data.outcome,
        answer: parsed.data.answer,
        answeredVia: rights.ownLogin ? 'web' : 'super',
        updatedAt: at,
      });
      return { status: 200, body: request };
    }
    return error(404, 'not_found');
  }
}
