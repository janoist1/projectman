import { createHash, randomBytes } from 'node:crypto';
import { AcceptInviteRequest, OwnerInvitationView, isOwnerAccount } from '@projectman/shared';
import type {
  CreateOwnerInviteRequest,
  CreatedOwnerInvitation,
  PublicOwnerInviteView,
} from '@projectman/shared';
import type { OwnerInvitationRecord, UserRecord } from '../../db';
import type { DomainContext } from '../base';
import { conflict, DomainError, forbidden, invalid, KeyedMutex, newId, notFound } from '../../kernel';
import type { InvitationAccounts, InvitationUser } from './ports';

const DAY_MS = 24 * 60 * 60 * 1000;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Owner invitations (PM-1062), the sibling of the project invitations: the host owner invites an e-mail
 * address; accepting it gives the account (the existing one, or a new one with a password) an owner account,
 * which lets it create projects and engines of its own. The link is handed over like a project invitation's.
 */
export class OwnerInvitationService {
  private readonly ctx: DomainContext;
  private readonly accounts: InvitationAccounts;
  // Serializes the creation, the acceptance and the revocation of owner invitations.
  private readonly lock = new KeyedMutex();

  constructor(deps: { ctx: DomainContext; accounts: InvitationAccounts }) {
    this.ctx = deps.ctx;
    this.accounts = deps.accounts;
  }

  private view(invite: OwnerInvitationRecord): OwnerInvitationView {
    return OwnerInvitationView.parse({
      ...invite,
      invitedBy: this.ctx.repos.users.get(invite.createdBy)?.name ?? '',
    });
  }

  /** The address is the host owner's, or already has an active owner account. */
  private assertNoOwnerAccount(user: UserRecord | null): void {
    if (
      user &&
      (this.accounts.isHostOwner(user.id) || isOwnerAccount(this.ctx.repos.ownerAccounts.get(user.id)))
    )
      throw conflict('owner_account_exists', 'this email already belongs to an owner');
  }

  private assertHostOwner(user: InvitationUser): void {
    if (!this.accounts.isHostOwner(user.id)) throw forbidden('owner_only', 'only the host owner may do this');
  }

  create(input: CreateOwnerInviteRequest, user: InvitationUser): Promise<CreatedOwnerInvitation> {
    return this.lock.run('owner-invitations', async () => {
      this.assertHostOwner(user);
      const email = input.email.trim().toLowerCase();
      this.assertNoOwnerAccount(this.ctx.repos.users.findByEmail(email));
      const token = randomBytes(32).toString('base64url');
      const now = this.ctx.now();
      const invite: OwnerInvitationRecord = {
        id: newId('oinv'),
        email,
        tokenHash: tokenHash(token),
        createdBy: user.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 7 * DAY_MS).toISOString(),
        acceptedAt: null,
        acceptedUserId: null,
        revokedAt: null,
      };
      this.ctx.repos.ownerInvitations.insert(invite);
      return { ...this.view(invite), path: `/owner-invite/${token}` };
    });
  }

  list(user: InvitationUser): OwnerInvitationView[] {
    this.assertHostOwner(user);
    const now = this.ctx.now();
    return this.ctx.repos.ownerInvitations
      .list(now.toISOString(), new Date(now.getTime() - 30 * DAY_MS).toISOString())
      .map((invite) => this.view(invite));
  }

  revoke(id: string, user: InvitationUser): Promise<void> {
    return this.lock.run('owner-invitations', async () => {
      this.assertHostOwner(user);
      const invite = this.ctx.repos.ownerInvitations.get(id);
      if (!invite) throw notFound('owner invitation', id);
      if (invite.acceptedAt) throw conflict('invite_used', 'the invitation has already been accepted');
      if (!invite.revokedAt) this.ctx.repos.ownerInvitations.revoke(id, this.ctx.now().toISOString());
    });
  }

  private valid(token: string): OwnerInvitationRecord {
    const invite = this.ctx.repos.ownerInvitations.byTokenHash(tokenHash(token));
    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      invite.expiresAt <= this.ctx.now().toISOString() ||
      !this.accounts.isHostOwner(invite.createdBy)
    )
      throw new DomainError('invite_invalid', 'the invitation is invalid or no longer available', {
        status: 404,
      });
    return invite;
  }

  inspect(token: string): PublicOwnerInviteView {
    const invite = this.valid(token);
    return {
      inviterName: this.ctx.repos.users.get(invite.createdBy)?.name ?? '',
      expiresAt: invite.expiresAt,
      requiresLogin: this.ctx.repos.users.findByEmail(invite.email) !== null,
    };
  }

  /**
   * The same account rules as a project invitation: an existing address needs the login of its account, and
   * only one with a password (the integrator key of the next steps needs one); a new address creates the
   * account. Then the owner account is written (a revoked one is granted again) in one transaction.
   */
  accept(token: string, body: unknown, caller: InvitationUser | null): Promise<InvitationUser> {
    return this.lock.run('owner-invitations', async () => {
      const invite = this.valid(token);
      const existing = this.ctx.repos.users.findByEmail(invite.email);
      if (existing && caller?.id !== existing.id)
        throw conflict('login_required', 'log in as the account for the invited email');
      this.assertNoOwnerAccount(existing);
      if (existing?.passwordHash === null)
        throw forbidden(
          'invite_password_account_required',
          'this account has no password: an owner account needs one',
        );
      if (existing && !AcceptInviteRequest.safeParse(body ?? {}).success)
        throw invalid('invalid_request', 'invalid invitation acceptance body');
      let user = existing;
      if (!user) {
        const input = AcceptInviteRequest.required().safeParse(body ?? {});
        if (!input.success)
          throw invalid('invalid_request', 'name and a password of at least eight characters are required');
        user = await this.accounts.prepareUser({ ...input.data, email: invite.email });
      }
      const account = user;
      const at = this.ctx.now().toISOString();
      this.ctx.unitOfWork(() => {
        if (!existing) this.ctx.repos.users.insert(account);
        this.ctx.repos.ownerAccounts.grant(account.id, invite.createdBy, at);
        this.ctx.repos.ownerInvitations.accept(invite.id, account.id, at);
      });
      return account;
    });
  }
}
