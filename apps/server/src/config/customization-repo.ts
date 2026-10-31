import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectedOriginOf, hasConnectedOrigin } from '@projectman/shared';
import type { ConfigAuthor } from '../contracts';
import { runGit } from './git';
import type { GitResult } from './git';

export interface GitIdentity {
  name: string;
  email: string;
}

export interface CustomizationRepoOptions {
  /** Directory of the customization repository, e.g. ~/.projectman/customization. */
  rootDir: string;
  /** Committer of every commit (the author is whoever made the change). */
  committer?: GitIdentity;
}

/**
 * The customization git repository as the stores share it: one serial queue for every git call that
 * touches its index (the configuration store and the documents store both commit here), the
 * isolated git environment and the commit helper.
 */
export interface CustomizationRepo {
  readonly rootDir: string;
  /**
   * Serializes repository access: git's index is not concurrent, and a configuration save deletes
   * and rewrites the project directory, so reads of the working tree wait for it too.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Git in the repository root, or in `cwd` (a nested repository, e.g. a documents submodule). */
  git(args: string[], okCodes?: number[], cwd?: string): Promise<GitResult>;
  /** Commits only `paths` (of the repository at `cwd`, by default the root); returns the new HEAD. */
  commit(message: string, author: GitIdentity, paths: string[], cwd?: string): Promise<string>;
  /** Creates the repository with an initial commit if it does not exist yet. Idempotent. */
  init(): Promise<void>;
}

const DEFAULT_COMMITTER: GitIdentity = { name: 'projectman', email: 'projectman@localhost' };

const README = `# projectman customization repository

Project configuration (team, roles, pipeline, limits, role instructions) managed by projectman.
Every change made in the app is a commit here, so any version can be restored.

    projects/<KEY>/project.yaml   project, repositories, team limits
    projects/<KEY>/team.yaml      members, custom roles
    projects/<KEY>/pipeline.yaml  board columns, stages and labels
    documents/<KEY>/              the project's documents, a git submodule of its own
`;

/** Strips characters that would break the "Name <email>" author format. */
export function cleanIdentity(identity: GitIdentity): GitIdentity {
  const clean = (s: string) => s.replace(/[<>\r\n]/g, '').trim();
  return { name: clean(identity.name) || 'unknown', email: clean(identity.email) || 'unknown@localhost' };
}

/**
 * The commit message with the attribution trailers of the author (`extraTrailers` are the caller's
 * own, e.g. the documents' `Projectman-Actor`).
 */
export function attributedMessage(
  message: string,
  author: ConfigAuthor,
  extraTrailers: string[] = [],
): string {
  const line = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();
  const trailers = [
    ...extraTrailers,
    ...(author.via || author.superActor ? ['Projectman-Via: integrator'] : []),
    // The super origin (PM-757): the mode, the Operator's handle and the credential's id and visible
    // prefix, never its secret. `history()` rebuilds the actor from these.
    ...(author.superActor
      ? [
          ...(hasConnectedOrigin(author.superActor)
            ? [
                // The connected Claude (decision 66): who acted, whose Claude it was and who approved.
                `Projectman-Connected-Kind: ${author.superActor.kind}`,
                `Projectman-Connected-Handle: ${line(author.superActor.handle)}`,
                `Projectman-Connected-Holder: ${line(author.superActor.through.holder)}`,
                ...(author.superActor.approvedBy
                  ? [`Projectman-Connected-Approved-By: ${line(author.superActor.approvedBy)}`]
                  : []),
              ]
            : [
                'Projectman-Operator-Mode: super',
                `Projectman-Operator-Handle: ${line(author.superActor.handle)}`,
              ]),
          `Projectman-Credential-Id: ${line(connectedOriginOf(author.superActor)!.credential.id)}`,
          `Projectman-Credential-Prefix: ${line(connectedOriginOf(author.superActor)!.credential.prefix)}`,
          ...(author.superAuditId ? [`Projectman-Audit-Id: ${line(author.superAuditId)}`] : []),
        ]
      : []),
    ...(author.operator
      ? [
          `Projectman-Operator: ${line(author.operator)}`,
          `Projectman-Request: ${Array.from(line(author.request ?? ''))
            .slice(0, 280)
            .join('')}`,
        ]
      : []),
    ...(author.approvedBy ? [`Projectman-Approved-By: ${line(author.approvedBy)}`] : []),
    ...(author.operatorStepId ? [`Projectman-Step: ${line(author.operatorStepId)}`] : []),
    ...(author.operatorRequestId ? [`Projectman-Request-Id: ${line(author.operatorRequestId)}`] : []),
    ...(author.operatorAgreementVersion
      ? [`Projectman-Agreement-Version: ${author.operatorAgreementVersion}`]
      : []),
    ...(author.operatorApprovalMode ? [`Projectman-Approval-Mode: ${author.operatorApprovalMode}`] : []),
  ];
  // User messages cannot introduce attribution, even without server-generated trailers.
  const body = message.replace(/\r\n?/g, '\n').replace(/^[\t ]*Projectman-/gim, '> Projectman-');
  return body + (trailers.length ? `\n\n${trailers.join('\n')}` : '');
}

export function createCustomizationRepo(opts: CustomizationRepoOptions): CustomizationRepo {
  const rootDir = opts.rootDir;
  const committer = cleanIdentity(opts.committer ?? DEFAULT_COMMITTER);
  let queue: Promise<unknown> = Promise.resolve();
  let initialized: Promise<void> | null = null;

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  const git = (args: string[], okCodes?: number[], cwd: string = rootDir): Promise<GitResult> =>
    runGit(cwd, args, {
      okCodes,
      env: { GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email },
    });

  async function commit(
    message: string,
    author: GitIdentity,
    paths: string[],
    cwd: string = rootDir,
  ): Promise<string> {
    const a = cleanIdentity(author);
    await git(
      ['commit', '-q', '--no-verify', '-m', message, `--author=${a.name} <${a.email}>`, '--', ...paths],
      undefined,
      cwd,
    );
    return (await git(['rev-parse', 'HEAD'], undefined, cwd)).stdout.trim();
  }

  function init(): Promise<void> {
    initialized ??= exclusive(async () => {
      await mkdir(rootDir, { recursive: true });
      if (!existsSync(join(rootDir, '.git'))) await git(['init', '-q', '-b', 'main']);
      const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], [1]);
      if (head.code !== 0) {
        await writeFile(join(rootDir, 'README.md'), README);
        await git(['add', 'README.md']);
        await commit('Initialize customization repository', committer, ['README.md']);
      }
      await mkdir(join(rootDir, 'projects'), { recursive: true });
    }).catch((err) => {
      initialized = null;
      throw err;
    });
    return initialized;
  }

  return { rootDir, exclusive, git, commit, init };
}
