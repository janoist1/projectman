import { refused } from './errors';

/** The `owner/repository` of a GitHub origin URL (https or ssh); anything else is refused. */
export function githubRepoOf(origin: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(origin);
  if (!match) throw refused('origin must name a GitHub owner/repository');
  return match[1]!;
}
