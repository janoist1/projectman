import { ProjectSummary, routes } from '@projectman/shared';
import { z } from 'zod';
import type { CommandContext } from './context';
import { ApiError } from './http';

/**
 * `projectman check` (PM-1429): proves that the connection works, with the reader route that lists the projects
 * the key may reach. Status 0 when the server accepts the key; the failures end through the client's usual
 * mapping (3 for a rejected key, a wrong Access file or a credential file problem, 1 for anything else).
 */
export async function runCheck(ctx: CommandContext): Promise<number> {
  const response = await ctx.api.send({ method: 'GET', path: routes.projects(), write: false });
  const parsed = z.array(ProjectSummary).safeParse(response.json);
  if (!parsed.success)
    throw new ApiError('protocol', 'unexpected_response', 'the server answered in an unexpected shape');
  const keys = parsed.data.map((project) => project.key);
  await ctx.print(
    ctx.json
      ? `${JSON.stringify({ projects: keys })}\n`
      : `ok: the key is accepted; projects: ${keys.length === 0 ? '(none)' : keys.join(' ')}\n`,
  );
  return 0;
}
