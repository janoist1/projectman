import { realpath } from 'node:fs/promises';
import type { MemberWorkspaceKey } from '../contracts';
import { isInside } from './paths';

/**
 * The engine's own record of the member clones it prepared (PM-743): the runner's dependency gate
 * finds a session's clone by its working directory without asking the manager or crossing a link.
 */
export interface MemberWorkspaceRegistry {
  /** Records a clone after a successful `ensure`; `repoPath` is its real path. */
  register(key: MemberWorkspaceKey, repoPath: string): void;
  /** The key of the registered clone holding `path` (its realpath is the clone or below it); null otherwise or when realpath fails. */
  keyOf(path: string): Promise<MemberWorkspaceKey | null>;
}

/** Lives in memory: every start and resume `ensure`s the clone again, which registers it. */
export function createMemberWorkspaceRegistry(): MemberWorkspaceRegistry {
  const clones = new Map<string, MemberWorkspaceKey>();
  return {
    register(key, repoPath) {
      clones.set(repoPath, key);
    },
    async keyOf(path) {
      let real: string;
      try {
        real = await realpath(path);
      } catch {
        return null;
      }
      const exact = clones.get(real);
      if (exact) return exact;
      for (const [repoPath, key] of clones) {
        if (isInside(real, repoPath)) return key;
      }
      return null;
    },
  };
}
