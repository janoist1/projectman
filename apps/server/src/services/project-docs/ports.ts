/** The other user of a repository's slot: the member-initiated merges (PM-495). The real Merges satisfies it structurally. */
export interface DocWriteSlotPeer {
  busy(projectKey: string, repo: string): boolean;
  /** The card whose merge holds the slot; null: none. */
  holder(projectKey: string, repo: string): string | null;
  pump(): void;
}
