import type { EmailLoginDirectory, EmailLoginStanding } from '../../contracts';
import type { DomainContext } from '../base';
import type { ProjectService } from '../projects';
import { projectAccessFor } from './access';
import type { InvitationService } from './invitations';
import type { InvitationAccounts } from './ports';

const INELIGIBLE: EmailLoginStanding = { eligible: false };

/**
 * The directory the e-mail login asks (PM-670): who may be sent a code and what a redeemed code may do.
 *
 * An address is eligible only when it is a client and nothing else: it has a client account or an open
 * client invitation, is not the host owner, holds `client` access in every project it is a member of,
 * and has no open invitation of another access (that person logs in with a password). Whatever cannot be
 * known (a project whose configuration does not load) makes the address not eligible: it fails closed,
 * unlike the membership list of `/api/me`, which skips such a project.
 */
export function createEmailLoginDirectory(deps: {
  ctx: DomainContext;
  projects: ProjectService;
  invitations: InvitationService;
  accounts: Pick<InvitationAccounts, 'isHostOwner'>;
}): EmailLoginDirectory {
  const { ctx, projects, invitations, accounts } = deps;

  return {
    async standing(email) {
      const address = email.trim().toLowerCase();
      const user = ctx.repos.users.findByEmail(address);
      if (user && accounts.isHostOwner(user.id)) return INELIGIBLE;
      const open = ctx.repos.invitations.openByEmail(address, ctx.now().toISOString());
      if (open.some((invite) => invite.access !== 'client')) return INELIGIBLE;
      let clientProjects = 0;
      try {
        for (const summary of projects.summaries()) {
          const access = projectAccessFor(await projects.config(summary.key), address);
          if (!access) continue;
          if (access.access !== 'client') return INELIGIBLE;
          clientProjects += 1;
        }
      } catch (err) {
        ctx.logger.warn({ err }, 'could not load a project configuration for the e-mail login');
        return INELIGIBLE;
      }
      // A config-only member without an account or an invitation has nothing to log in to.
      if (!user && open.length === 0) return INELIGIBLE;
      if (clientProjects + open.length === 0) return INELIGIBLE;
      return {
        eligible: true,
        userId: user?.id ?? null,
        clientProjects,
        openClientInvites: open.length,
        inviteDisplayName: open.find((invite) => invite.displayName?.trim())?.displayName?.trim() ?? null,
      };
    },
    inviteEmail: (token) => invitations.openClientInviteEmail(token),
    acceptOpenClientInvites: (email, newAccountName) =>
      invitations.acceptOpenClientInvites(email.trim().toLowerCase(), newAccountName),
  };
}
