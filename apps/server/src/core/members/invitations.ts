import { assertIntegratorAccess, assertSuperMutation } from '../../kernel';
import { maskEmail, memberOf, roleBundle } from '@projectman/shared';
import type { UserRecord } from '../../db';
import { createHash, randomBytes } from 'node:crypto';
import { AcceptInviteRequest, InvitationView } from '@projectman/shared';
import type {
  Actor,
  CreateInviteRequest,
  CreatedInvitation,
  PublicInviteView,
  ProjectConfig,
  HumanMemberConfig,
  UiLanguage,
} from '@projectman/shared';
import type { InvitationAccounts, InvitationUser } from './ports';
import { findHumanByEmail, requireMemberAccess } from './access';
import { hasAccess } from '@projectman/shared';
import type { DomainContext } from '../base';
import { conflict, DomainError, forbidden, invalid, notFound } from '../../kernel';
import { assertRoleFor } from './members';
import type { MemberService } from './members';
import type { ProjectService } from '../projects';
import { roleViews } from '../projects';
import { KeyedMutex, newId } from '../../kernel';
import { humanMemberHandle } from './naming';

type InvitationRecord = Parameters<DomainContext['repos']['invitations']['insert']>[0];

const DAY_MS = 24 * 60 * 60 * 1000;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Colleague invitations: an owner or admin invites an email (optionally to an unclaimed seat);
 * accepting creates the account (unless it exists) and adds or binds the member in one
 * configuration commit.
 */
export class InvitationService {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly members: MemberService;
  /** Hashes the password of a new account (the account is stored after the commit). */
  private readonly accounts: InvitationAccounts;
  // Serializes account creation across projects, acceptance and revocation.
  private readonly lock = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    members: MemberService;
    accounts: InvitationAccounts;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.members = deps.members;
    this.accounts = deps.accounts;
  }

  async create(
    projectKey: string,
    input: CreateInviteRequest,
    user: InvitationUser,
  ): Promise<CreatedInvitation> {
    return this.lock.run('invitations', async () => {
      const config = await this.projects.config(projectKey);
      assertIntegratorAccess(config, 'write');
      const inviter = requireMemberAccess(findHumanByEmail(config, user.email), 'admin', {
        message: 'owner or admin required',
      });
      if (input.access === 'admin' && !hasAccess(inviter.access, 'owner'))
        throw forbidden('owner_only', 'only an owner may invite an admin');
      const member = input.memberHandle ? this.unclaimedMember(config, input.memberHandle) : undefined;
      if (findHumanByEmail(config, input.email))
        throw conflict('already_member', 'this email is already a human member');
      for (const role of input.roles) {
        assertRoleFor(config, role, 'human');
        if (
          !member &&
          !hasAccess(inviter.access, 'owner') &&
          roleBundle(config, role).duties.includes('release_approval')
        )
          throw forbidden('owner_only', 'only an owner may grant release approval');
      }
      if (
        member &&
        this.list(projectKey).some(
          (invite) =>
            invite.memberHandle === member.handle &&
            !invite.acceptedAt &&
            !invite.revokedAt &&
            invite.expiresAt > this.ctx.now().toISOString(),
        )
      )
        throw conflict('member_invite_pending', 'this member already has an open invitation');
      const token = randomBytes(32).toString('base64url');
      const now = this.ctx.now();
      const invite: InvitationRecord = {
        id: newId('inv'),
        projectKey,
        email: input.email,
        displayName: member?.displayName ?? input.displayName ?? null,
        ...(member ? { memberHandle: member.handle } : {}),
        access: input.access,
        roles: [...new Set(member?.roles ?? input.roles)],
        invitedBy: user.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 7 * DAY_MS).toISOString(),
        acceptedAt: null,
        revokedAt: null,
        tokenHash: tokenHash(token),
      };
      this.ctx.repos.invitations.insert(invite);
      return { ...InvitationView.parse(invite), path: `/invite/${token}` };
    });
  }

  private unclaimedMember(config: ProjectConfig, handle: string): HumanMemberConfig {
    const member = memberOf(config, handle);
    if (!member)
      throw new DomainError('invite_member_not_found', 'invited member does not exist', { status: 404 });
    if (member.kind !== 'human') throw invalid('invite_member_not_human', 'invited member must be human');
    if (member.email) throw conflict('member_has_account', 'this member already has an email');
    return member;
  }

  list(projectKey: string): InvitationView[] {
    const now = this.ctx.now();
    return this.ctx.repos.invitations
      .list(projectKey, now.toISOString(), new Date(now.getTime() - 30 * DAY_MS).toISOString())
      .map((invite) => InvitationView.parse(invite));
  }

  revoke(projectKey: string, id: string): Promise<void> {
    return this.lock.run('invitations', async () => {
      assertIntegratorAccess(await this.projects.config(projectKey), 'write');
      assertSuperMutation(await this.projects.config(projectKey), {
        kind: 'remove',
        resource: 'invitation',
        id,
      });
      const invite = this.ctx.repos.invitations.get(id);
      if (!invite || invite.projectKey !== projectKey) throw notFound('invitation', id);
      if (invite.acceptedAt) throw conflict('invite_used', 'the invitation has already been accepted');
      if (!invite.revokedAt) this.ctx.repos.invitations.revoke(id, this.ctx.now().toISOString());
    });
  }

  private open(invite: InvitationRecord | null): InvitationRecord {
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= this.ctx.now().toISOString())
      throw new DomainError('invite_invalid', 'the invitation is invalid or no longer available', {
        status: 404,
      });
    return invite;
  }

  private valid(token: string): InvitationRecord {
    return this.open(this.ctx.repos.invitations.byTokenHash(tokenHash(token)));
  }

  /** The invited address of an open client invitation, or null for any other token (PM-670; never throws). */
  openClientInviteEmail(token: string): string | null {
    const invite = this.ctx.repos.invitations.byTokenHash(tokenHash(token));
    if (!invite || invite.access !== 'client') return null;
    try {
      return this.open(invite).email;
    } catch {
      return null;
    }
  }

  async inspect(token: string): Promise<PublicInviteView> {
    const invite = this.valid(token);
    const config = await this.projects.config(invite.projectKey);
    const inviter = this.ctx.repos.users.get(invite.invitedBy)!;
    const catalogue = roleViews(config);
    return {
      projectKey: invite.projectKey,
      projectName: config.project.name,
      inviterName: findHumanByEmail(config, inviter.email)?.displayName ?? inviter.name,
      displayName: invite.displayName,
      access: invite.access,
      roles: invite.roles,
      roleNames: invite.roles.map((id) => catalogue.find((role) => role.id === id)?.name ?? id),
      expiresAt: invite.expiresAt,
      requiresLogin: this.ctx.repos.users.findByEmail(invite.email) !== null,
      ...(invite.access === 'client' ? { emailHint: maskEmail(invite.email) } : {}),
    };
  }

  /**
   * Accepts every open client invitation of an address (the e-mail login, PM-670), each through the same
   * configuration commit as `accept`. A refused one (for instance its inviter is no longer an admin) is
   * skipped and logged by code; the others still go through. The account (the existing one, or a new
   * passwordless one named `newAccountName`) is stored with the first successful commit.
   */
  acceptOpenClientInvites(
    email: string,
    newAccountName: string | null,
    language?: UiLanguage,
  ): Promise<{ userId: string | null; accepted: number }> {
    return this.lock.run('invitations', async () => {
      const invites = this.ctx.repos.invitations
        .openByEmail(email, this.ctx.now().toISOString())
        .filter((invite) => invite.access === 'client');
      const existing = this.ctx.repos.users.findByEmail(email);
      let account: UserRecord | null = existing;
      let stored = existing !== null;
      let accepted = 0;
      for (const invite of invites) {
        if (!account) {
          if (!newAccountName) break;
          account = this.accounts.preparePasswordlessUser({
            name: newAccountName,
            email: invite.email,
            language,
          });
        }
        try {
          await this.commitAcceptance(invite, account, !stored);
          stored = true;
          accepted += 1;
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
          this.ctx.logger.info({ invitationId: invite.id, code: err.code }, 'client invitation not accepted');
        }
      }
      return { userId: stored ? account!.id : null, accepted };
    });
  }

  /**
   * The configuration commit of an acceptance: the inviter is checked again inside the draft, the member
   * is added or bound, and only then the account (when new) and the acceptance are stored.
   */
  private async commitAcceptance(
    invite: InvitationRecord,
    account: UserRecord,
    insertAccount: boolean,
  ): Promise<void> {
    const inviterUser = this.ctx.repos.users.get(invite.invitedBy);
    const inviter = requireMemberAccess(
      inviterUser
        ? findHumanByEmail(await this.projects.config(invite.projectKey), inviterUser.email)
        : undefined,
      'admin',
      { message: 'inviter no longer manages this team' },
    );
    const actor: Actor = { kind: 'human', handle: inviter.handle };
    await this.projects.update(
      invite.projectKey,
      {
        actor,
        author: { name: account.name, email: account.email },
        ...(invite.memberHandle
          ? { invitationBinding: { handle: invite.memberHandle, email: account.email } }
          : {}),
      },
      (draft) => {
        this.open(this.ctx.repos.invitations.get(invite.id));
        const currentInviter = requireMemberAccess(
          inviterUser ? findHumanByEmail(draft, inviterUser.email) : undefined,
          'admin',
          { message: 'inviter no longer manages this team' },
        );
        if (invite.access === 'admin' && !hasAccess(currentInviter.access, 'owner'))
          throw forbidden('owner_only', 'only an owner may invite an admin');
        const member = invite.memberHandle ? this.unclaimedMember(draft, invite.memberHandle) : undefined;
        if (findHumanByEmail(draft, invite.email))
          throw conflict('already_member', 'this email is already a human member');
        if (member) {
          for (const role of member.roles) assertRoleFor(draft, role, 'human');
          member.email = account.email;
          member.access = invite.access;
        } else {
          for (const role of invite.roles) {
            assertRoleFor(draft, role, 'human');
            if (
              !hasAccess(currentInviter.access, 'owner') &&
              roleBundle(draft, role).duties.includes('release_approval')
            )
              throw forbidden('owner_only', 'only an owner may grant release approval');
          }
          const handle = humanMemberHandle(account.name, this.members.takenHandles(invite.projectKey, draft));
          draft.team.members.push({
            kind: 'human',
            handle,
            displayName: account.name,
            email: account.email,
            access: invite.access,
            roles: invite.roles,
          });
        }
        return `Invite accepted: ${account.name}`;
      },
    );
    this.ctx.unitOfWork(() => {
      if (insertAccount) this.ctx.repos.users.insert(account);
      this.ctx.repos.invitations.accept(invite.id, this.ctx.now().toISOString());
    });
  }

  accept(token: string, body: unknown, caller: InvitationUser | null): Promise<InvitationUser> {
    return this.lock.run('invitations', async () => {
      const invite = this.valid(token);
      const existing = this.ctx.repos.users.findByEmail(invite.email);
      if (existing && caller?.id !== existing.id)
        throw conflict('login_required', 'log in as the account for the invited email');
      // A passwordless account (e-mail login) takes only client invitations; the password path stays for the rest.
      if (existing?.passwordHash === null && invite.access !== 'client')
        throw forbidden(
          'invite_password_account_required',
          'this account has no password: only a client invitation can be accepted with it',
        );
      if (existing && !AcceptInviteRequest.safeParse(body ?? {}).success)
        throw invalid('invalid_request', 'invalid invitation acceptance body');
      let user = existing;
      if (!user) {
        const input = AcceptInviteRequest.required({ name: true, password: true }).safeParse(body ?? {});
        if (!input.success)
          throw invalid('invalid_request', 'name and a password of at least eight characters are required');
        user = await this.accounts.prepareUser({ ...input.data, email: invite.email });
      }
      const account = user;
      await this.commitAcceptance(invite, account, !existing);
      return account;
    });
  }
}
