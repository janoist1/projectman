import path from 'node:path';
import { INTEGRATOR_TOKEN_FILE, ENGINE_TOKEN_FILE, readTokenFile } from './cloudflare';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import type { StepResult } from './report';
import { secretFileProblem } from './secrets';

/**
 * `check --login-json <file>` (PM-536): the verification of the public board from the owner's computer. It runs
 * the curl checks of `deploy/cloudflare/check.sh` (Access in front, the edge settings, the origin rules), then
 * the three doors of the engine with the engine service token (it passes Access, and the board must still
 * refuse it), and, when there is an integrator token, `deploy/cloud/smoke.sh` with it.
 */

export interface CheckOptions {
  loginJson: string;
}

const CHECK_TIMEOUT_MS = 300_000;
/** The engine's doors (PM-317): a GET on each must never be answered with a success. */
const ENGINE_DOORS = [
  '/engine/link',
  '/engine/files/downloads/smoke-test',
  '/engine/files/uploads/smoke-test',
];
const FETCH_TIMEOUT_MS = 20_000;

function outputLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

function accessRedirect(response: Response): boolean {
  if (response.status < 300 || response.status > 399) return false;
  return /cloudflareaccess\.com/i.test(response.headers.get('location') ?? '');
}

async function engineDoor(
  context: CloudContext,
  url: string,
  headers: Record<string, string>,
): Promise<Response | null> {
  try {
    return await context.deps.fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

async function checkEngineDoors(context: CloudContext, origin: string): Promise<StepResult> {
  const { report } = context;
  const file = path.join(context.secretsDir, ENGINE_TOKEN_FILE);
  const token = readTokenFile(file);
  if (!token) throw refused(`${file} is missing or not a service token file; run "npm run cloud -- edge"`);
  report.protect(token.clientId);
  report.protect(token.clientSecret);
  const withToken = {
    'CF-Access-Client-Id': token.clientId,
    'CF-Access-Client-Secret': token.clientSecret,
  };
  const failures: string[] = [];
  for (const door of ENGINE_DOORS) {
    const anonymous = await engineDoor(context, `${origin}${door}`, {});
    if (!anonymous) failures.push(`${door} without a token: no answer`);
    else if (!(accessRedirect(anonymous) || anonymous.status === 403))
      failures.push(`${door} without a token answered ${anonymous.status}, not the Access login or 403`);
    const authorized = await engineDoor(context, `${origin}${door}`, withToken);
    if (!authorized) failures.push(`${door} with the engine token: no answer (000)`);
    else if (authorized.status >= 200 && authorized.status <= 299)
      failures.push(`${door} with the engine token answered ${authorized.status}: the door is open`);
    else if (accessRedirect(authorized))
      failures.push(`${door} with the engine token went to the Access login: the token is not accepted`);
  }
  if (failures.length > 0) throw new CloudError(`the engine's doors: ${failures.join('; ')}`);
  return {
    status: 'ok',
    detail: `${ENGINE_DOORS.length} doors: Access in front, and closed for the engine token itself`,
  };
}

export async function runCheck(context: CloudContext, options: CheckOptions): Promise<void> {
  const { config, report, deps } = context;
  const login = path.resolve(options.loginJson);
  const problem = secretFileProblem(login);
  if (problem) throw refused(problem);
  const origin = `https://${config.cloudflare.hostname}`;

  await report.run('access-checks', async () => {
    const env: Record<string, string> = { LOGIN_JSON: login };
    if (config.cloudflare.feedbackHostname)
      env.FEEDBACK_ORIGIN = `https://${config.cloudflare.feedbackHostname}`;
    const result = await deps.run(
      'bash',
      [path.join(deps.repoRoot, 'deploy', 'cloudflare', 'check.sh'), origin],
      {
        env,
        timeoutMs: CHECK_TIMEOUT_MS,
      },
    );
    for (const line of outputLines(result.stdout)) report.line(`  ${line}`);
    if (result.code === 2)
      throw refused(
        `check.sh could not start: ${outputLines(result.stderr).slice(-2).join(' ') || 'a precondition is missing'}`,
      );
    if (result.code !== 0)
      throw new CloudError(`check.sh found problems (exit ${result.code}); the FAIL lines above name them`);
    return { status: 'ok', detail: origin };
  });

  await report.run('engine-doors', () => checkEngineDoors(context, origin));

  if (!config.access.integratorServiceToken) {
    report.step('skipped', 'integrator-smoke', 'access.integratorServiceToken is off');
    return;
  }
  await report.run('integrator-smoke', async () => {
    const file = path.join(context.secretsDir, INTEGRATOR_TOKEN_FILE);
    const token = readTokenFile(file);
    if (!token) throw refused(`${file} is missing or not a service token file; run "npm run cloud -- edge"`);
    report.protect(token.clientId);
    report.protect(token.clientSecret);
    // The token goes through the environment, never through the arguments.
    const result = await deps.run('bash', [path.join(deps.repoRoot, 'deploy', 'cloud', 'smoke.sh'), origin], {
      env: { CF_ACCESS_CLIENT_ID: token.clientId, CF_ACCESS_CLIENT_SECRET: token.clientSecret },
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    for (const line of outputLines(result.stdout + '\n' + result.stderr)) report.line(`  ${line}`);
    if (result.code !== 0) throw new CloudError(`smoke.sh failed (exit ${result.code})`);
    return { status: 'ok', detail: 'the integrator token passes Access' };
  });
}
