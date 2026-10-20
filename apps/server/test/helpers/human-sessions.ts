import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../../src/auth';
import { humanActor } from '../../src/kernel';
import { OWNER_LOGIN } from './app-harness';
import type { HumanLogin } from './app-harness';

/** Real signed sessions for API authorization tests, with one membership configuration commit. */
export async function createHumanSessions(
  app: FastifyInstance,
  humans: Record<string, HumanLogin>,
): Promise<Record<string, string>> {
  const { repos, domain, auth } = app.projectman;
  const cookies: Record<string, string> = {};
  const members = Object.values(humans);
  const projectKeys = members.flatMap((h) => (h.projectKey === null ? [] : [h.projectKey ?? 'AR']));
  for (const projectKey of new Set(projectKeys)) {
    const joining = members.filter((h) => (h.projectKey === undefined ? 'AR' : h.projectKey) === projectKey);
    if (joining.length === 0) continue;
    await domain.projects.update(projectKey, { actor: humanActor('owner'), author: OWNER_LOGIN }, (draft) => {
      for (const human of joining) {
        draft.team.members.push({
          kind: 'human',
          handle: human.handle,
          displayName: human.name ?? human.handle,
          email: human.email ?? `${human.handle}@example.test`,
          access: human.access ?? 'developer',
          roles: human.roles ?? [],
        });
        human.adjust?.(draft);
      }
      return 'Add fictional test members';
    });
  }
  for (const [key, human] of Object.entries(humans)) {
    const id = `usr_${human.handle}`;
    repos.users.insert({
      id,
      name: human.name ?? human.handle,
      email: human.email ?? `${human.handle}@example.test`,
      passwordHash: repos.users.findByEmail(OWNER_LOGIN.email)!.passwordHash,
      createdAt: new Date().toISOString(),
    });
    cookies[key] = `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(auth.createSession(id)))}`;
  }
  return cookies;
}
