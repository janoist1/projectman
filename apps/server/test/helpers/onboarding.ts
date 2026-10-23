import type { Domain } from '../../src/assembly';

/** Fixtures for unrelated behavior represent an existing project, without its initial greeting. */
export async function withoutOnboarding<T>(domain: Domain, create: () => Promise<T>): Promise<T> {
  const ensure = domain.memberQueueDriver.ensure;
  domain.memberQueueDriver.ensure = async () => {};
  try {
    const result = await create();
    domain.ctx.repos.db
      .prepare("DELETE FROM member_queue_items WHERE source_type = 'checklist' AND source_id = 'onboarding'")
      .run();
    return result;
  } finally {
    domain.memberQueueDriver.ensure = ensure;
  }
}
