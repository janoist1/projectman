import path from 'node:path';
import {
  INTEGRATOR_TOKEN_FILE,
  ENGINE_TOKEN_FILE,
  OWNERS_DIR,
  isPublicBoard,
  ownerDir,
  ownersOf,
  readTokenFile,
} from './cloudflare';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import type { StepResult } from './report';
import { secretFileProblem } from './secrets';

/**
 * `check --login-json <file>` (PM-536): the verification of the public board from the owner's computer. It runs
 * the curl checks of `deploy/cloudflare/check.sh` (Access in front, the edge settings, the origin rules), then
 * the three doors of the engine with the engine service token (it passes Access, and the board must still
 * refuse it), and, when there is an integrator token, `deploy/cloud/smoke.sh` with it. With
 * `access.boardMode: public` (PM-672) check.sh runs its public matrix (the board's own login is the boundary), the
 * engine token must also give no board rights. A separate integrator host is checked with its own token;
 * the browser check deliberately presents a valid owner cookie there without an application bearer.
 */

interface CheckOptions {
  loginJson: string;
}

const CHECK_TIMEOUT_MS = 300_000;
/** The engine's doors (PM-317): a GET on each must never be answered with a success. */
const ENGINE_DOORS = [
  '/engine/link',
  '/engine/files/downloads/smoke-test',
  '/engine/files/uploads/smoke-test',
];
/**
 * The same door with an encoded letter (PM-672): the tunnel rule matches the raw path, the board's router decodes
 * it. Whichever application catches it, it must not reach the engine's handler: the board itself answers 404.
 */
const ENCODED_ENGINE_DOOR = '/%65ngine/link';
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

type TokenHeaders = Record<string, string>;

/** The `CF-Access-*` headers of a token file; null when the file is missing or not a token file. Both parts are masked. */
function tokenHeaders(context: CloudContext, file: string): TokenHeaders | null {
  const token = readTokenFile(file);
  if (!token) return null;
  context.report.protect(token.clientId);
  context.report.protect(token.clientSecret);
  return { 'CF-Access-Client-Id': token.clientId, 'CF-Access-Client-Secret': token.clientSecret };
}

/**
 * The engine's doors with an engine service token: `who` names it in the messages. The anonymous probes do not
 * depend on the token, so they run only once (`withAnonymous`).
 */
async function checkEngineDoors(
  context: CloudContext,
  origin: string,
  withToken: TokenHeaders,
  holder: string,
  withAnonymous: boolean,
): Promise<string[]> {
  const failures: string[] = [];
  for (const door of ENGINE_DOORS) {
    const anonymous = withAnonymous ? await engineDoor(context, `${origin}${door}`, {}) : undefined;
    if (anonymous === null) failures.push(`${door} without a token: no answer`);
    else if (anonymous && !(accessRedirect(anonymous) || anonymous.status === 403))
      failures.push(`${door} without a token answered ${anonymous.status}, not the Access login or 403`);
    const authorized = await engineDoor(context, `${origin}${door}`, withToken);
    if (!authorized) failures.push(`${door} with ${holder}: no answer (000)`);
    else if (authorized.status >= 200 && authorized.status <= 299)
      failures.push(`${door} with ${holder} answered ${authorized.status}: the door is open`);
    else if (accessRedirect(authorized))
      failures.push(`${door} with ${holder} went to the Access login: the token is not accepted`);
  }
  // Nobody is let in by the encoded spelling, with or without the token: the Access login, 403 or the board's 404.
  for (const [who, headers] of [
    ...(withAnonymous ? [['without a token', {}] as const] : []),
    [`with ${holder}`, withToken] as const,
  ]) {
    const encoded = await engineDoor(context, `${origin}${ENCODED_ENGINE_DOOR}`, headers);
    if (!encoded) failures.push(`${ENCODED_ENGINE_DOOR} ${who}: no answer`);
    else if (!(accessRedirect(encoded) || encoded.status === 403 || encoded.status === 404))
      failures.push(
        `${ENCODED_ENGINE_DOOR} ${who} answered ${encoded.status}, not the Access login, 403 or 404`,
      );
  }
  if (isPublicBoard(context.config)) {
    // The engine token opens the engine application and nothing else: on the board it is no login (PM-672).
    const board = await engineDoor(context, `${origin}/api/auth/me`, withToken);
    if (!board) failures.push(`/api/auth/me with ${holder}: no answer`);
    else if (board.status !== 401)
      failures.push(`/api/auth/me with ${holder} answered ${board.status}, not 401: it gives board rights`);
  }
  return failures;
}

async function checkHostEngineDoors(context: CloudContext, origin: string): Promise<StepResult> {
  const file = path.join(context.secretsDir, ENGINE_TOKEN_FILE);
  const headers = tokenHeaders(context, file);
  if (!headers) throw refused(`${file} is missing or not a service token file; run "npm run cloud -- edge"`);
  const failures = await checkEngineDoors(context, origin, headers, 'the engine token', true);
  if (failures.length > 0) throw new CloudError(`the engine's doors: ${failures.join('; ')}`);
  return {
    status: 'ok',
    detail: `${ENGINE_DOORS.length} doors: Access in front, and closed for the engine token itself`,
  };
}

function integratorHeaders(context: CloudContext): Record<string, string> {
  const headers = tokenHeaders(context, path.join(context.secretsDir, INTEGRATOR_TOKEN_FILE));
  if (!headers) throw refused('the integrator service token file is missing or invalid');
  return headers;
}

/**
 * The integrator host with an integrator token (`own`) and an engine token (`wrong`): the engine token is no key
 * there, the integrator token passes Access and needs the application key, and it does not open `/engine`.
 */
async function integratorDoorProblems(
  context: CloudContext,
  origin: string,
  own: TokenHeaders,
  wrong: TokenHeaders,
  withAnonymous: boolean,
): Promise<string[]> {
  const machine = `https://${context.config.cloudflare.integratorHostname}`;
  const problems: string[] = [];
  for (const door of ['/api/projects', '/mcp']) {
    for (const headers of withAnonymous ? [{}, wrong] : [wrong]) {
      const answer = await engineDoor(context, `${machine}${door}`, headers);
      if (!answer || !(accessRedirect(answer) || answer.status === 403))
        problems.push(`${door} accepts a missing or wrong service token`);
    }
    const answer = await engineDoor(context, `${machine}${door}`, own);
    if (!answer || answer.status !== 401) problems.push(`${door} is not 401 without an application key`);
  }
  const crossed = await engineDoor(context, `${origin}/engine/link`, own);
  if (!crossed || !(accessRedirect(crossed) || crossed.status === 403))
    problems.push('the integrator service token opens the engine application');
  return problems;
}

async function checkIntegratorDoors(context: CloudContext, origin: string): Promise<StepResult> {
  const machine = `https://${context.config.cloudflare.integratorHostname}`;
  const own = integratorHeaders(context);
  const engine = tokenHeaders(context, path.join(context.secretsDir, ENGINE_TOKEN_FILE));
  if (!engine) throw refused('the engine service token file is missing or invalid');
  const problems = await integratorDoorProblems(context, origin, own, engine, true);
  for (const door of ['/', '/ws', '/engine/link', '/feedback/widget.js', '/mcp/token', '/hooks/x']) {
    const answer = await engineDoor(context, `${machine}${door}`, own);
    if (!answer || answer.status !== 404) problems.push(`${door} is not closed on the machine host`);
  }
  if (problems.length) throw new CloudError(`the integrator boundary: ${problems.join('; ')}`);
  return {
    status: 'ok',
    detail: 'separate Access audience, application key required, human and internal doors closed',
  };
}

/**
 * A further owner's two tokens (PM-1065), tried from the host's copy: the engine token passes the three engine doors
 * and nothing else; the integrator token passes Access on the machine host only. Neither opens the other's door.
 * No copy at the host (the owner's file was never made here, or it is gone) is a skipped step, not a failure.
 */
async function checkOwnerDoors(
  context: CloudContext,
  origin: string,
  owner: { id: string; name: string },
): Promise<StepResult> {
  const dir = ownerDir(context.secretsDir, owner.id);
  const engine = tokenHeaders(context, path.join(dir, ENGINE_TOKEN_FILE));
  const integrator = tokenHeaders(context, path.join(dir, INTEGRATOR_TOKEN_FILE));
  if (!engine || !integrator)
    return {
      status: 'skipped',
      detail: `${owner.name}: ${OWNERS_DIR}/${owner.id} has no usable copy of ${[
        ...(engine ? [] : [ENGINE_TOKEN_FILE]),
        ...(integrator ? [] : [INTEGRATOR_TOKEN_FILE]),
      ].join(' and ')} (run edge, or edge --rotate-owner-token ${owner.id})`,
    };
  const problems = [
    ...(await checkEngineDoors(context, origin, engine, `the engine token of ${owner.id}`, false)),
    ...(await integratorDoorProblems(context, origin, integrator, engine, false)),
  ];
  if (problems.length) throw new CloudError(`the doors of owner ${owner.id}: ${problems.join('; ')}`);
  return {
    status: 'ok',
    detail: `${owner.name}: own engine token and own integrator token, each at its own door only`,
  };
}

export async function runCheck(context: CloudContext, options: CheckOptions): Promise<void> {
  const { config, report, deps } = context;
  const login = path.resolve(options.loginJson);
  const problem = secretFileProblem(login);
  if (problem) throw refused(problem);
  const origin = `https://${config.cloudflare.hostname}`;

  await report.run('access-checks', async () => {
    const env: Record<string, string> = { LOGIN_JSON: login, BOARD_MODE: config.access.boardMode };
    if (config.cloudflare.integratorHostname) {
      const headers = integratorHeaders(context);
      env.INTEGRATOR_ORIGIN = `https://${config.cloudflare.integratorHostname}`;
      env.CF_ACCESS_CLIENT_ID = headers['CF-Access-Client-Id']!;
      env.CF_ACCESS_CLIENT_SECRET = headers['CF-Access-Client-Secret']!;
    }
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

  await report.run('engine-doors', () => checkHostEngineDoors(context, origin));

  if (config.cloudflare.integratorHostname) {
    await report.run('integrator-doors', () => checkIntegratorDoors(context, origin));
    for (const owner of ownersOf(config))
      await report.run(`owner-doors ${owner.id}`, () => checkOwnerDoors(context, origin, owner));
    return;
  }

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
