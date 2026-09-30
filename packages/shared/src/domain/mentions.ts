/** Mention tokens share the same boundaries in comments and their rendered text. */
export function mentionTokens(text: string): Array<{ start: number; end: number; handle: string }> {
  return [...text.matchAll(/(?<![\p{L}\p{N}_@.+-])@([a-z0-9][a-z0-9-]*)(?![\p{L}\p{N}_@-])/giu)].map(
    (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      handle: match[1]!.toLowerCase(),
    }),
  );
}

export function commentMentions(text: string, handles: readonly string[], author: string | null): string[] {
  const members = new Map(handles.map((handle) => [handle.toLowerCase(), handle]));
  return [
    ...new Set(
      mentionTokens(text).flatMap((token) => {
        const handle = members.get(token.handle);
        return handle && handle.toLowerCase() !== author?.toLowerCase() ? [handle] : [];
      }),
    ),
  ];
}
