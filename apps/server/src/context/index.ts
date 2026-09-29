import type { ContextPackBuilder, MemberMemoryStore } from '../contracts';

/** Placeholders until the context module is implemented (owned by the context workstream). */
export function createContextPackBuilder(): ContextPackBuilder {
  throw new Error('context pack builder not implemented yet');
}

export function createMemberMemoryStore(_opts: { rootDir: string }): MemberMemoryStore {
  throw new Error('member memory store not implemented yet');
}
