import type { ContextPackBuilder } from '../contracts';

export {
  createMemberMemoryStore,
  formatMemoryEntry,
  MEMORY_LIMIT_BYTES,
  recentMemory,
  type MemberMemoryStoreOptions,
} from './memory';

/** Placeholder until the context pack builder is implemented (owned by the context workstream). */
export function createContextPackBuilder(): ContextPackBuilder {
  throw new Error('context pack builder not implemented yet');
}
