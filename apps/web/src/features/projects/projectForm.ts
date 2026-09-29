import { t } from '../../i18n/t';

export const KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const REPO_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const GITHUB_RE = /^[\w.-]+\/[\w.-]+$/;

export interface RepoRow {
  id: number;
  name: string;
  path: string;
  github: string;
  defaultBranch: string;
}

export interface RepoErrors {
  name?: string;
  path?: string;
  github?: string;
}

/** Repos entered in the form, in the RepoConfig shape the server accepts. */
export function reposPayload(rows: readonly RepoRow[]) {
  return rows
    .filter((row) => row.name.trim() || row.path.trim())
    .map((row) => ({
      name: row.name.trim(),
      path: row.path.trim(),
      ...(row.github.trim() ? { github: row.github.trim() } : {}),
      defaultBranch: row.defaultBranch.trim() || 'main',
    }));
}

export function validateRepos(rows: readonly RepoRow[]): Record<number, RepoErrors> {
  const errors: Record<number, RepoErrors> = {};
  for (const row of rows) {
    if (!row.name.trim() && !row.path.trim()) continue;
    const entry: RepoErrors = {};
    if (!REPO_NAME_RE.test(row.name.trim())) entry.name = t('projects.validation.repoNameInvalid');
    if (!row.path.trim()) entry.path = t('projects.validation.repoPathRequired');
    if (row.github.trim() && !GITHUB_RE.test(row.github.trim()))
      entry.github = t('projects.validation.repoGithubInvalid');
    if (Object.keys(entry).length > 0) errors[row.id] = entry;
  }
  return errors;
}

let repoSeq = 0;
export const newRepo = (): RepoRow => ({
  id: (repoSeq += 1),
  name: '',
  path: '',
  github: '',
  defaultBranch: 'main',
});

/** Project key suggestion from the name: "Acme webshop" → "AW", "Kosár" → "KO". */
export function suggestKey(name: string): string {
  const letters = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .trim();
  const words = letters.split(/\s+/).filter(Boolean);
  if (words.length >= 2)
    return words
      .map((word) => word[0])
      .join('')
      .slice(0, 4);
  return (words[0] ?? '').slice(0, 2);
}
