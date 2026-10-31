/** The documents list of a project; `slug` opens one document. */
export function documentsPath(projectKey: string, slug?: string): string {
  return slug ? `/p/${projectKey}/docs/${slug}` : `/p/${projectKey}/docs`;
}

/** The reference people and AI members share: the slug, with `#anchor` for a section. */
export function documentRef(slug: string, anchor?: string): string {
  return anchor ? `${slug}#${anchor}` : slug;
}
