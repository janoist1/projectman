/**
 * The public board (PM-672, PM-664): the cloud board is reachable without Cloudflare Access in front of its
 * pages, and every visitor meets the application's own login. It is a start-time switch, `PROJECTMAN_PUBLIC_BOARD`
 * (`0` default, `1`), and it creates no way in by itself: it only refuses to start where the application's own
 * login would be missing.
 */

export const PUBLIC_BOARD_REQUIRES_CLOUD = 'public_board_requires_cloud';
export const PUBLIC_BOARD_REQUIRES_SETUP = 'public_board_requires_setup';
export const PUBLIC_BOARD_REQUIRES_EMAIL_LOGIN = 'public_board_requires_email_login';

type PublicBoardProblem =
  | typeof PUBLIC_BOARD_REQUIRES_CLOUD
  | typeof PUBLIC_BOARD_REQUIRES_SETUP
  | typeof PUBLIC_BOARD_REQUIRES_EMAIL_LOGIN;

/** The start stops with this: the public board is switched on but the instance is not ready for it. */
export class PublicBoardNotReadyError extends Error {
  readonly code: PublicBoardProblem;

  constructor(code: PublicBoardProblem, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'PublicBoardNotReadyError';
    this.code = code;
  }
}

/** `PROJECTMAN_PUBLIC_BOARD` is `0` (default) or `1`; anything else stops the start. */
export function parsePublicBoardEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.PROJECTMAN_PUBLIC_BOARD?.trim() || '0';
  if (value !== '0' && value !== '1') throw new Error(`invalid PROJECTMAN_PUBLIC_BOARD: ${value} (0 or 1)`);
  return value === '1';
}

/**
 * The public board starts only in cloud mode, with an owner already set up (so there is no anonymous first
 * setup to take) and a working e-mail login (the way clients come in). Throws the first missing condition.
 */
export function assertPublicBoardReady(state: {
  cloud: boolean;
  needsSetup: boolean;
  emailLogin: boolean;
}): void {
  if (!state.cloud)
    throw new PublicBoardNotReadyError(
      PUBLIC_BOARD_REQUIRES_CLOUD,
      'the public board runs only in cloud mode',
    );
  if (state.needsSetup)
    throw new PublicBoardNotReadyError(
      PUBLIC_BOARD_REQUIRES_SETUP,
      'the first owner must be set up before the board is public',
    );
  if (!state.emailLogin)
    throw new PublicBoardNotReadyError(
      PUBLIC_BOARD_REQUIRES_EMAIL_LOGIN,
      'the e-mail login must work before the board is public (PROJECTMAN_EMAIL_LOGIN_ENABLED=1)',
    );
}
