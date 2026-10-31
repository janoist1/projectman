import { z } from 'zod';
import { MemberHandle } from './member';

/** The identifier of a document: the file name in the project's documents repository, fixed at creation. */
export const DocumentSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type DocumentSlug = z.infer<typeof DocumentSlug>;

/** A version of a document: the commit in the project's documents repository. */
export const DocumentVersionId = z.string().regex(/^[0-9a-f]{40}$/);
export type DocumentVersionId = z.infer<typeof DocumentVersionId>;

/** The markdown of a document, in UTF-8 bytes (the front matter not counted). */
export const MAX_DOCUMENT_BYTES = 200_000;
export const MAX_DOCUMENT_TITLE_LENGTH = 200;

export const DocumentChangeAuthor = z.object({
  kind: z.enum(['human', 'ai', 'system']),
  /** From the `Projectman-Actor` trailer; null when the commit has none. */
  handle: MemberHandle.nullable(),
  /** The name of the commit's author. */
  name: z.string(),
});
export type DocumentChangeAuthor = z.infer<typeof DocumentChangeAuthor>;

export const DocumentSummary = z.object({
  slug: DocumentSlug,
  title: z.string().min(1).max(MAX_DOCUMENT_TITLE_LENGTH),
  /** The last commit of the document's file. */
  version: DocumentVersionId,
  /** ISO 8601, the time of that commit. */
  updatedAt: z.string(),
  updatedBy: DocumentChangeAuthor,
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

export const DocumentVersion = z.object({
  version: DocumentVersionId,
  at: z.string(),
  by: DocumentChangeAuthor,
  /** The subject line of the commit. */
  message: z.string(),
  /** The title as of this version. */
  title: z.string(),
  /** The commit that deleted the document. */
  deleted: z.boolean(),
});
export type DocumentVersion = z.infer<typeof DocumentVersion>;

const MAX_SLUG_LENGTH = 64;

/**
 * The slug of a new document, made from its title: NFD, accents removed, lower case, every run of
 * characters other than [a-z0-9] becomes '-', outer dashes are cut, 64 characters at most; nothing
 * left is 'document'. A taken slug (a current or a deleted document) gets '-2', '-3' … within the limit.
 */
export function documentSlugOf(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, MAX_SLUG_LENGTH)
      .replace(/-+$/, '') || 'document';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
