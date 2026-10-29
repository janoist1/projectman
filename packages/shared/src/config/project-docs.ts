import { z } from 'zod';
import type { ProjectConfig, RepoConfig } from './schema';

/** The project documents the Operator keeps (PM-388, PM-1004). */
export const ProjectDoc = z.enum(['decisions', 'roadmap', 'lessons']);
export type ProjectDoc = z.infer<typeof ProjectDoc>;

/** Only a nonempty batch of lessons edits has the Operator's autonomous writing permission. */
export function isLessonsOnly(edits: readonly { doc: ProjectDoc }[]): boolean {
  return edits.length > 0 && edits.every((edit) => edit.doc === 'lessons');
}

/**
 * Why a write of the project documents did not go up (PM-495). `authorization_revoked` (PM-784): the
 * bearer key or its holder's ownership ended, or an autonomous lessons write lost its Operator/configuration
 * authorization before publication.
 */
export const DocWriteFailure = z.enum([
  'engine_offline',
  'base_out_of_sync',
  'checkout_conflict',
  'remote_moved',
  'push_rejected',
  'remote_unreachable',
  'local_checkout',
  'git_failed',
  'authorization_revoked',
]);
export type DocWriteFailure = z.infer<typeof DocWriteFailure>;

/**
 * A relative POSIX path inside a repository: 1..200 characters, no leading '/', no '\\', no NUL, no
 * empty, '.' or '..' segment, and the first segment is not '.git'.
 */
export function isRepoFilePath(path: string): boolean {
  if (path.length < 1 || path.length > 200) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  return segments[0] !== '.git';
}

const RepoFilePath = z.string().min(1).max(200).refine(isRepoFilePath, 'Not a path inside the repository');

/** Where a repository keeps the project documents. A document with no path is off. */
export const RepoDocs = z
  .object({
    decisions: RepoFilePath.optional(),
    roadmap: RepoFilePath.optional(),
    lessons: RepoFilePath.optional(),
  })
  .strict()
  .refine((docs) => {
    const paths = Object.values(docs).filter((path) => path !== undefined);
    return new Set(paths).size === paths.length;
  }, 'document paths must differ');
export type RepoDocs = z.infer<typeof RepoDocs>;

/**
 * The project's document files: those of the first repository that has `docs` with a path (when
 * several have it, the first counts); null when no repository has a path.
 */
export function projectDocsOf(
  config: Pick<ProjectConfig, 'project'>,
): { repo: RepoConfig; decisions: string | null; roadmap: string | null; lessons: string | null } | null {
  for (const repo of config.project.repos) {
    const decisions = repo.docs?.decisions ?? null;
    const roadmap = repo.docs?.roadmap ?? null;
    const lessons = repo.docs?.lessons ?? null;
    if (decisions !== null || roadmap !== null || lessons !== null)
      return { repo, decisions, roadmap, lessons };
  }
  return null;
}
