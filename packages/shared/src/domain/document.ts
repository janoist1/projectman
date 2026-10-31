import { z } from 'zod';
import { MemberHandle } from './member';
import type { TaskViewer } from './task';

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

/**
 * Whoever acts on documents. `delegated`: the request comes through the integrator (`via`) or the
 * super mode, which never deletes.
 */
export type DocumentViewer = TaskViewer & { delegated?: boolean };

/** Every member reads except a client (PM-79 made a client read the whole project; a document is an exception). */
export function canReadDocuments(viewer: DocumentViewer): boolean {
  return viewer.access !== 'client';
}

/** Create, edit, rename and restore: owner, admin, developer and every AI member; a viewer only reads. */
export function canEditDocuments(viewer: DocumentViewer): boolean {
  return (
    viewer.access === 'owner' ||
    viewer.access === 'admin' ||
    viewer.access === 'developer' ||
    viewer.access === 'ai'
  );
}

/** Delete: a human owner or admin with their own login; an AI member never. */
export function canDeleteDocument(viewer: DocumentViewer): boolean {
  return (viewer.access === 'owner' || viewer.access === 'admin') && !viewer.delegated;
}

export interface DocumentHeading {
  level: 1 | 2 | 3 | 4;
  text: string;
  anchor: string;
}

/** The anchor of a heading text: NFD, accents removed, lower case, other runs → '-', outer dashes cut; empty → 'section'. */
export function sectionAnchor(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

interface HeadingAt extends DocumentHeading {
  line: number;
}

function headingsOf(lines: readonly string[]): HeadingAt[] {
  const headings: HeadingAt[] = [];
  const used = new Set<string>();
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (marker) {
      fence = marker;
      return;
    }
    // The same rule as the page's markdown view (`apps/web/src/components/Markdown.tsx`).
    const match = /^(#{1,4})\s+(.*)$/.exec(line);
    if (!match) return;
    const text = (match[2] ?? '').trim();
    const base = sectionAnchor(text);
    let anchor = base;
    for (let n = 2; used.has(anchor); n++) anchor = `${base}-${n}`;
    used.add(anchor);
    headings.push({ level: (match[1] ?? '#').length as DocumentHeading['level'], text, anchor, line: index });
  });
  return headings;
}

const linesOf = (markdown: string) => markdown.split(/\r?\n/);

/**
 * The headings of a document in order: a line starting with `#` to `####` and a space, outside code
 * blocks (``` or ~~~). A repeated anchor gets '-2', '-3' …
 */
export function documentOutline(markdown: string): DocumentHeading[] {
  return headingsOf(linesOf(markdown)).map(({ level, text, anchor }) => ({ level, text, anchor }));
}

/**
 * A section: from its heading to the next heading of the same or a higher level, subsections
 * included; the last one runs to the end. `ref` is an anchor or a heading text, both normalised
 * with `sectionAnchor`; nothing found → null.
 */
export function documentSection(
  markdown: string,
  ref: string,
): { heading: DocumentHeading; content: string } | null {
  const lines = linesOf(markdown);
  const headings = headingsOf(lines);
  const wanted = sectionAnchor(ref);
  const found =
    headings.find((heading) => heading.anchor === wanted) ??
    headings.find((heading) => sectionAnchor(heading.text) === wanted);
  if (!found) return null;
  const next = headings.find((heading) => heading.line > found.line && heading.level <= found.level);
  const content = lines
    .slice(found.line, next?.line ?? lines.length)
    .join('\n')
    .trimEnd();
  return { heading: { level: found.level, text: found.text, anchor: found.anchor }, content };
}

/** 'projektterv#2-a-munka-utja' → { slug: 'projektterv', section: '2-a-munka-utja' }; without '#' (or after an empty one) no section. */
export function parseDocumentRef(ref: string): { slug: string; section?: string } {
  const hash = ref.indexOf('#');
  if (hash < 0) return { slug: ref };
  const section = ref.slice(hash + 1);
  return section ? { slug: ref.slice(0, hash), section } : { slug: ref.slice(0, hash) };
}

/** The reason of a change (PM-1215): one line, required for every write (create, edit, rename, restore, delete). */
const DocumentCommitMessage = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]*$/);

/** Whether a refused write request failed because its `message` is missing or blank (the `document_message_required` error). */
export function lacksDocumentMessage(error: z.ZodError): boolean {
  return error.issues.some(
    (issue) => issue.path[0] === 'message' && (issue.code === 'invalid_type' || issue.code === 'too_small'),
  );
}

const DocumentTitle = z.string().trim().min(1).max(MAX_DOCUMENT_TITLE_LENGTH);

export const DocumentDetail = z.object({ document: DocumentSummary, content: z.string() });
export type DocumentDetail = z.infer<typeof DocumentDetail>;

export const DocumentListResponse = z.object({ documents: z.array(DocumentSummary) });
export type DocumentListResponse = z.infer<typeof DocumentListResponse>;

export const CreateDocumentRequest = z.object({
  title: DocumentTitle,
  content: z.string(),
  message: DocumentCommitMessage,
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequest>;

export const UpdateDocumentRequest = z
  .object({
    baseVersion: DocumentVersionId,
    title: DocumentTitle.optional(),
    content: z.string().optional(),
    message: DocumentCommitMessage,
  })
  .refine((request) => request.title !== undefined || request.content !== undefined, {
    path: ['content'],
    message: 'title or content is required',
  });
export type UpdateDocumentRequest = z.infer<typeof UpdateDocumentRequest>;

export const RestoreDocumentRequest = z.object({
  version: DocumentVersionId,
  baseVersion: DocumentVersionId,
  message: DocumentCommitMessage,
});
export type RestoreDocumentRequest = z.infer<typeof RestoreDocumentRequest>;

/** A delete carries its parameters in the query string. */
export const DeleteDocumentQuery = z.object({
  baseVersion: DocumentVersionId,
  message: DocumentCommitMessage,
});
export type DeleteDocumentQuery = z.infer<typeof DeleteDocumentQuery>;

export const DeleteDocumentResponse = z.object({
  slug: DocumentSlug,
  deleted: z.literal(true),
  version: DocumentVersionId,
});
export type DeleteDocumentResponse = z.infer<typeof DeleteDocumentResponse>;

export const DocumentHistoryResponse = z.object({ versions: z.array(DocumentVersion) });
export type DocumentHistoryResponse = z.infer<typeof DocumentHistoryResponse>;
