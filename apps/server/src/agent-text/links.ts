import type { TaskLink } from '@projectman/shared';
import { oneLine, PLAIN_STYLE, type TextStyle } from './text';

/** Longer link titles are shortened. */
const TITLE_LIMIT = 200;

const LINK_KINDS: Record<TaskLink['kind'], string> = {
  pull_request: 'Pull request',
  issue: 'Issue',
  branch: 'Branch',
  url: 'Link',
  prerequisite: 'Prerequisite',
};

/** "acme/app#123" for a pull request or issue number, else the reference as it is. */
export function numberedRef(ref: string, repo: string | null | undefined): string {
  return /^\d+$/.test(ref) ? `${repo ?? ''}#${ref}` : ref;
}

/** A link without its kind: `acme/app#123 "Fix the mail" (open)`, `` `branch` in acme/app ``, … */
export function linkTarget(link: TaskLink, style: Pick<TextStyle, 'code'> = PLAIN_STYLE): string {
  const title = link.title ? ` "${oneLine(link.title, TITLE_LIMIT)}"` : '';
  const state = link.state ? ` (${link.state})` : '';
  switch (link.kind) {
    case 'pull_request':
    case 'issue':
      return `${numberedRef(link.ref, link.repo)}${title}${state}`;
    case 'branch':
      return `${style.code(link.ref)}${link.repo ? ` in ${link.repo}` : ''}${state}`;
    case 'url':
      return `${link.ref}${title}`;
    case 'prerequisite':
      return `${link.ref}${title}${state}`;
  }
}

/** A link with its kind: `Pull request: acme/app#123 "Fix the mail" (open)`. */
export function describeLink(link: TaskLink, style: Pick<TextStyle, 'code'> = PLAIN_STYLE): string {
  return `${LINK_KINDS[link.kind]}: ${linkTarget(link, style)}`;
}
