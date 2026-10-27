import type { Me, OwnerAccountView } from '@projectman/shared';
import type { Repositories } from '../db';
import type { PauseRequester } from '../runtime/sessions';
import { forbidden, notFound } from '../kernel';
import type { AuthService } from './auth-service';

/** What the revocation needs of the rest of the system (the domain and the engine registry). */
export interface OwnerAccountPorts {
  /** The projects the e-mail address is a member of, with the access they have. */
  projectsFor(email: string): Promise<Me['projects']>;
  /** The access the e-mail address has to the project; null for none. */
  accessFor(projectKey: string, email: string): Promise<unknown | null>;
  pauses: { pause(target: { scope: 'project'; projectKey: string }, by: PauseRequester): Promise<void> };
  /** The registry of engine keys; absent on a single-machine installation, where owner accounts have none. */
  engines?: {
    listFor(viewer: { userId: string }): { id: string; revokedAt: string | null }[];
    revoke(id: string, userId: string): unknown;
  };
}

/**
 * The owner accounts of the instance (PM-1062): the list, and the host owner's revocation. Revoking is one
 * request and repeating it is harmless: the account stops creating projects and engines, the projects they
 * created (and the ones they own that the host cannot see) are paused, their engines are revoked and their integrator keys are revoked. The
 * login and the data stay.
 */
export class OwnerAccountService {
  private readonly repos: Repositories;
  private readonly auth: AuthService;
  private readonly ports: OwnerAccountPorts;
  private readonly now: () => Date;

  constructor(deps: { repos: Repositories; auth: AuthService; ports: OwnerAccountPorts; now?: () => Date }) {
    this.repos = deps.repos;
    this.auth = deps.auth;
    this.ports = deps.ports;
    this.now = deps.now ?? (() => new Date());
  }

  private assertHostOwner(userId: string): void {
    if (!this.auth.isHostOwner(userId)) throw forbidden('owner_only', 'only the host owner may do this');
  }

  list(host: { id: string }): OwnerAccountView[] {
    this.assertHostOwner(host.id);
    return this.repos.ownerAccounts.list().flatMap((account) => {
      const user = this.repos.users.get(account.userId);
      return user
        ? [
            {
              userId: user.id,
              name: user.name,
              email: user.email,
              grantedAt: account.grantedAt,
              revokedAt: account.revokedAt,
            },
          ]
        : [];
    });
  }

  async revoke(userId: string, host: { id: string; email: string }): Promise<OwnerAccountView> {
    this.assertHostOwner(host.id);
    const user = this.repos.users.get(userId);
    if (!user || !this.repos.ownerAccounts.get(userId)) throw notFound('owner account', userId);
    this.repos.ownerAccounts.revoke(userId, host.id, this.now().toISOString());
    // The projects stay in the owner's hands, but their work stops now: every project the user created (a fact
    // the server wrote, whoever the configuration names a member since), and every other project they own
    // where the host has no seat.
    const toPause = new Set(this.repos.projects.keysCreatedBy(userId));
    for (const project of await this.ports.projectsFor(user.email))
      if (project.access === 'owner' && !(await this.ports.accessFor(project.key, host.email)))
        toPause.add(project.key);
    for (const projectKey of toPause)
      await this.ports.pauses.pause({ scope: 'project', projectKey }, { userId: host.id, source: 'app' });
    for (const engine of this.ports.engines?.listFor({ userId }) ?? [])
      if (!engine.revokedAt) this.ports.engines?.revoke(engine.id, host.id);
    this.auth.revokeIntegratorAccessKeysOf(userId);
    return this.list(host).find((account) => account.userId === userId)!;
  }
}
